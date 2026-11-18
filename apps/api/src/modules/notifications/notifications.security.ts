import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import { z } from 'zod';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { OnDomainEvent } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  type SecurityAlerted,
  securityAlerted,
} from '../../iam/account/account.events.js';
import type { SecurityAlertKind } from '../../iam/account/account.mails.js';
import { NotificationsService } from './notifications.service.js';
import { defineNotifications } from './notifications.types.js';

/** Each alert of iam/account and its notification type (texts: i18n/en.json, `security`). */
const TYPES = {
  newSignIn: 'security.new-sign-in',
  passwordChanged: 'security.password-changed',
  passwordBreached: 'security.password-breached',
  mfaEnabled: 'security.mfa-enabled',
  mfaDisabled: 'security.mfa-disabled',
  passkeyAdded: 'security.passkey-added',
  passkeyRemoved: 'security.passkey-removed',
} as const satisfies Record<SecurityAlertKind, string>;

/**
 * The account's security alerts as notifications: in-app and realtime, and
 * push when the person turns it on (through quiet hours). Never mailed from
 * here, and email not offered (`fixed`): iam/account mails every alert
 * itself (SecurityAlertMail), with or without this module and in no tenant,
 * so there is one mail per alert. Mandatory: never switched off.
 */
export const SECURITY_NOTIFICATIONS = defineNotifications(
  Object.values(TYPES).map((type) => ({
    type,
    email: false as const,
    fixed: ['email'] as const,
    push: false,
    mandatory: true,
    urgent: true,
    data: z.object({
      ip: z.string(),
      device: z.string().optional(),
      name: z.string().optional(),
      at: z.iso.datetime(),
    }),
  })),
);

/**
 * Stores each alert iam/account publishes (`account.security-alerted`, in
 * no tenant) in the tenant the person was acting in. An alert of no tenant
 * (a reset link, an operator's change) has no inbox to go to: its mail is
 * all there is.
 */
@Injectable()
export class SecurityNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly tenancy: Tenancy,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  @OnDomainEvent(securityAlerted, { consumer: 'notifications.security' })
  async alerted(event: SecurityAlerted, ctx: OutboxHandlerContext) {
    if (!event.tenantId) {
      return;
    }
    const to = { kind: 'user' as const, id: event.userId };
    const settled = await this.tenancy.run(event.tenantId, () =>
      this.txHost.withTransaction(async () =>
        ctx.processInTransaction(this.txHost.tx, async () => {
          await this.notifications.notify({
            type: TYPES[event.kind],
            to,
            data: { ...event.args, at: event.at },
            link: '/account/security',
          });
          // A changed password settles an unread breach notice (in this
          // tenant: one stored in another stays until read there).
          return event.kind === 'passwordChanged'
            ? this.notifications.settleType(to, TYPES.passwordBreached)
            : 0;
        }),
      ),
    );
    if (settled) {
      await this.tenancy.run(event.tenantId, () =>
        this.notifications.announceUnread(to),
      );
    }
  }
}
