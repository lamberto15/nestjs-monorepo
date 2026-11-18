import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import {
  NonRetryableMessageError,
  type OutboxHandlerContext,
} from '@nestjs/outbox';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Events, OnDomainEvent } from '../../core/outbox/events.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import type { Principal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { DevicesService } from './notifications.devices.service.js';
import { NotificationCatalog } from './notifications.catalog.js';
import { notificationsConfig } from './notifications.config.js';
import { nextDigestTime } from './digest-time.js';
import {
  notificationCreatedWebhook,
  notificationStored,
} from './notifications.events.js';
import { NotificationMail } from './notifications.mails.js';
import { NotificationPreferencesService } from './notifications.preferences.service.js';
import { PUSH_QUEUE, type PushJob } from './notifications.push.js';
import { NotificationsService } from './notifications.service.js';
import { notifications } from './notifications.tables.js';
import { UnsubscribeLinks } from './notifications.unsubscribe.js';
import type { EmailMode } from './notifications.types.js';
import { quietUntil } from './quiet-hours.js';

/**
 * Delivers a stored notification through its channels, on a worker, once
 * the transaction that created it committed (the outbox relay hands it
 * over, in the tenant it was sent in): the recipient as they are now
 * (nothing for one deactivated, or no longer a member of the tenant), their
 * preferences, the texts in their language, then
 *
 * - **email** (users): queued at once (`immediate`), or flagged with when its
 *   digest is due (`hourly`, `daily`: NotificationDigestJob);
 * - **push** (users with a registered browser): one job per browser, held
 *   until the recipient's quiet hours end unless the type is `urgent`;
 * - **realtime**: the recipient's connections hear it, after the commit.
 *
 * The mail and push jobs have ids made from the notification, so a delivery
 * retried after a failure queues them once; the flags commit with the
 * outbox's inbox record, so the delivery counts once.
 */
@Injectable()
export class NotificationDelivery {
  private readonly logger = new Logger('Notifications');

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly catalog: NotificationCatalog,
    private readonly notifications: NotificationsService,
    private readonly events: Events,
    private readonly preferences: NotificationPreferencesService,
    private readonly users: UsersRepository,
    private readonly devices: DevicesService,
    private readonly mailQueue: MailQueue,
    private readonly links: UnsubscribeLinks,
    private readonly i18n: I18nService,
    @InjectQueue(PUSH_QUEUE) private readonly pushQueue: Queue<PushJob>,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @OnDomainEvent(notificationStored, { consumer: 'notifications' })
  async deliver(
    { notificationId }: { notificationId: string },
    ctx: OutboxHandlerContext,
  ) {
    const [row] = await this.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    if (!row || row.deliveredAt) {
      return; // collapsed away or removed since; or delivered before a crash
    }
    const declaration = this.catalog.declaration(row.type);
    if (!declaration) {
      throw new NonRetryableMessageError(
        `Notification type "${row.type}" is no longer declared.`,
      );
    }
    const recipient = await this.recipient(row.recipient, row.tenantId);
    if (!recipient) {
      // Deactivated since: the stored notification stays, nothing is sent.
      await this.db
        .update(notifications)
        .set({ deliveredAt: new Date() })
        .where(eq(notifications.id, row.id));
      return;
    }
    const user = recipient.kind === 'user' ? recipient : undefined;
    const settings = this.catalog.effective(
      declaration,
      (await this.preferences.overrides(row.recipient))[row.type],
      recipient,
    );
    const locale = user?.locale ?? this.i18n.defaultLocale;
    const rendered = this.catalog.render(row.type, row.data, row.count, locale);
    const timezone = user?.timezone ?? this.config.timezone;

    // Before the transaction: a call to Redis waits for as long as Redis is
    // down, and must not hold a database connection meanwhile.
    const mode = settings.email as EmailMode | false | undefined;
    if (user && mode === 'immediate') {
      await this.mailQueue.send(
        NotificationMail,
        {
          to: { name: user.name, address: user.email },
          data: {
            name: user.name,
            ...rendered,
            link: row.link,
            // A mandatory type can't be switched off: no unsubscribe offered.
            unsubscribe: declaration.mandatory
              ? null
              : await this.links.signType(user.id, row.type),
          },
          locale,
        },
        {
          jobId: `notification-${row.id}`,
          signal: ctx.signal,
          // A mandatory type (a security notice) still goes while only essential mail does.
          essential: declaration.mandatory === true,
        },
      );
    }
    if (user && settings.push === true) {
      // Quiet hours hold back what disturbs, not an urgent type.
      const quiet = declaration.urgent
        ? null
        : quietUntil(
            new Date(),
            await this.preferences.quietHoursOf(row.recipient),
            timezone,
          );
      for (const device of await this.devices.forSending(user.id)) {
        await this.pushQueue.add(
          'push',
          {
            deviceId: device.id,
            notificationId: row.id,
            ...rendered,
            link: row.link,
            urgent: declaration.urgent === true,
          },
          {
            jobId: `push-${row.id}-${device.id}`,
            ...(quiet && { delay: Math.max(0, quiet.getTime() - Date.now()) }),
          },
        );
      }
    }

    const result = await this.txHost.withTransaction(async () =>
      ctx.processInTransaction(this.txHost.tx, async () => {
        const now = new Date();
        const digest =
          user && (mode === 'hourly' || mode === 'daily')
            ? {
                digest: mode,
                digestDueAt: nextDigestTime(
                  mode,
                  now,
                  timezone,
                  this.config.digestHour,
                ),
              }
            : {};
        await this.db
          .update(notifications)
          .set({
            deliveredAt: now,
            ...(user && mode === 'immediate' && { emailedAt: now }),
            ...digest,
          })
          .where(eq(notifications.id, row.id));
        // An API client hears it as a webhook, when it subscribed to the type.
        if (recipient.kind === 'client') {
          await this.events.publish(notificationCreatedWebhook, {
            ...this.notifications.view(row, locale),
            clientId: recipient.id,
          });
        }
      }),
    );
    if (result.duplicate) return;

    // The stored notification, the mail and the push are done: a socket emit
    // that failed is not worth a retry of the whole.
    try {
      this.notifications.pushCreated(
        recipient,
        this.notifications.view(row, locale),
      );
      await this.notifications.announceUnread(recipient);
    } catch (error) {
      this.logger.warn('The realtime push failed after the commit', {
        notificationId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The recipient as they are now: null when deactivated (or revoked) since,
   * or no longer a member of the notification's tenant (a person who left a
   * tenant hears nothing more of it).
   */
  private async recipient(
    key: string,
    tenantId: string,
  ): Promise<Principal | null> {
    const [kind, id] = key.split(':') as [string, string];
    if (kind === 'user') {
      return this.users.inTenant(id, tenantId);
    }
    if (kind !== 'client') {
      return null; // the system has no inbox: notify() never stores one for it
    }
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(and(eq(apiClients.id, id), eq(apiClients.active, true)));
    return client
      ? { kind: 'client', id: client.id, name: client.name, tenantId }
      : null;
  }
}
