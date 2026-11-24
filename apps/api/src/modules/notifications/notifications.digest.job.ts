import { TransactionHost } from '@nestjs-cls/transactional';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { I18nService } from '@nestjs/i18n';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { MailQueue } from '../../core/mail/mail.queue.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { NotificationCatalog } from './notifications.catalog.js';
import { notificationsConfig } from './notifications.config.js';
import { NotificationDigestMail } from './notifications.mails.js';
import { NotificationsRepository } from './notifications.repository.js';
import { UnsubscribeLinks } from './notifications.unsubscribe.js';

/** At most this many notifications are listed in one digest; the rest is a count. */
const DIGEST_ITEMS = 100;

const JOB = 'notification-digests';

/**
 * Mails the digests that are due: every hour, on one instance, one mail per
 * recipient with the notifications flagged for a digest whose time has come
 * (hourly ones at once, daily ones at NOTIFICATIONS_DIGEST_HOUR in the
 * recipient's zone). After downtime, everything due goes in the next run.
 * `run(now)` lets a test choose the moment.
 *
 * One mail per person, whatever the tenants: a digest is the person's, so
 * the job reads every tenant's due rows at once (`acrossTenants`), and lists
 * a row only when the person is still an active member of its tenant; the
 * others are unflagged, unsent.
 */
@Injectable()
export class NotificationDigestJob {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly repository: NotificationsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly users: UsersRepository,
    private readonly mailQueue: MailQueue,
    private readonly catalog: NotificationCatalog,
    private readonly i18n: I18nService,
    private readonly tenancy: Tenancy,
    private readonly links: UnsubscribeLinks,
    @Inject(notificationsConfig.KEY)
    private readonly config: ConfigType<typeof notificationsConfig>,
  ) {}

  @Cron('5 * * * *', { name: JOB, timeZone: 'UTC' })
  @OnOneInstance({ key: 'notifications:digest' })
  @WithoutOverlapping()
  run(now = new Date()) {
    return this.tenancy.acrossTenants(JOB, async () => {
      const due = await this.repository.digestRecipients(now);
      let mails = 0;
      let items = 0;
      for (const recipient of due) {
        const user = recipient.startsWith('user:')
          ? await this.users.findActive(recipient.slice('user:'.length))
          : null;
        const flagged = await this.repository.digestItems(recipient, now);
        if (flagged.length === 0) continue;
        // Only what the person may still see: the tenants they are still an active member of.
        const member = new Map<string, boolean>();
        for (const tenantId of new Set(flagged.map((row) => row.tenantId))) {
          member.set(
            tenantId,
            user ? await this.users.isMember(user.id, tenantId) : false,
          );
        }
        const rows = flagged.filter((row) => member.get(row.tenantId));
        // The rows are unflagged before the mail is queued: a digest lost
        // rather than sent twice. Rows not listed (a person gone, a tenant
        // left) are unflagged too, unsent.
        await this.txHost.withTransaction(async () => {
          await this.repository.updateMany(
            flagged.map((row) => row.id),
            { digest: null, digestDueAt: null },
          );
          if (rows.length > 0) {
            await this.repository.updateMany(
              rows.map((row) => row.id),
              { emailedAt: now },
            );
          }
        });
        if (!user || rows.length === 0) continue;
        const locale = user.locale ?? this.i18n.defaultLocale;
        const listed = rows.slice(0, DIGEST_ITEMS);
        // Unsubscribing from a digest switches off the types in its modes
        // (never the mandatory ones): offered when it lists any other.
        const modes = rows.flatMap((row) =>
          row.digest && !this.catalog.declaration(row.type)?.mandatory
            ? [row.digest]
            : [],
        );
        try {
          await this.mailQueue.send(NotificationDigestMail, {
            to: { name: user.name, address: user.email },
            data: {
              name: user.name,
              items: listed.map((row) => ({
                ...this.catalog.render(row.type, row.data, row.count, locale),
                link: row.link,
                at: row.createdAt,
              })),
              count: rows.length,
              more: rows.length - listed.length,
              timezone: user.timezone,
              unsubscribe:
                modes.length > 0
                  ? await this.links.signDigests(user.id, modes)
                  : null,
            },
            locale,
          });
        } catch (error) {
          this.logger.error(`A digest could not be queued for ${recipient}`, {
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        mails++;
        items += rows.length;
      }
      this.logger.log('Notification digests sent', { mails, items });
      return { mails, items };
    });
  }
}
