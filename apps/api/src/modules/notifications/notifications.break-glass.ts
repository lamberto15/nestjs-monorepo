import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import type { OutboxHandlerContext } from '@nestjs/outbox';
import { z } from 'zod';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { OnDomainEvent } from '../../core/outbox/events.js';
import { breakGlassStarted } from '../../iam/break-glass/break-glass.events.js';
import { NotificationsService } from './notifications.service.js';
import { defineNotifications } from './notifications.types.js';

/** What a tenant's administrators get when an operator opens it with break-glass (texts: i18n/en.json). */
export const BREAK_GLASS_NOTIFICATIONS = defineNotifications([
  {
    // Who, why, until when: mailed at once, never switched off, through quiet hours.
    type: 'security.break-glass-started',
    email: 'immediate',
    mandatory: true,
    urgent: true,
    data: z.object({
      operator: z.string(),
      reason: z.string(),
      expiresAt: z.iso.datetime(),
      ip: z.string().optional(),
    }),
  },
]);

/**
 * Tells a tenant's administrators that an operator opened it with a
 * break-glass grant (iam/break-glass publishes `tenancy.break-glass-started`
 * in that tenant; this runs in it, on a worker, once per grant).
 */
@Injectable()
export class BreakGlassNotices {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  @OnDomainEvent(breakGlassStarted, { consumer: 'notifications.break-glass' })
  async started(
    event: NonNullable<(typeof breakGlassStarted)['payload']>,
    ctx: OutboxHandlerContext,
  ) {
    if (event.administrators.length === 0) {
      return;
    }
    await this.txHost.withTransaction(async () =>
      ctx.processInTransaction(this.txHost.tx, () =>
        this.notifications.notify({
          type: 'security.break-glass-started',
          to: event.administrators.map((id) => ({ kind: 'user' as const, id })),
          data: {
            operator: event.operator.email,
            reason: event.reason,
            expiresAt: event.expiresAt,
            ...(event.ip && { ip: event.ip }),
          },
          key: `break-glass:${event.grantId}`,
        }),
      ),
    );
  }
}
