import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import {
  notificationPreferences,
  notifications,
  pushDevices,
  recordSubscriptions,
} from './notifications.tables.js';

/**
 * What notifications hold about the person. In each tenant: their
 * notifications and the records they watch. In their account: their
 * preferences and their push devices (without the keys that reach them).
 * All of it goes with their account.
 */
@PersonalData({ name: 'notifications', scopes: ['tenant', 'account'] })
@Injectable()
export class NotificationsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ key, userId, tenantId }: PersonalDataSubject) {
    if (tenantId === null) {
      yield (
        await this.db
          .select()
          .from(notificationPreferences)
          .where(eq(notificationPreferences.recipient, key))
      ).map((row) => ({ kind: 'preferences', ...row }));
      yield (
        await this.db
          .select({
            id: pushDevices.id,
            name: pushDevices.name,
            endpoint: pushDevices.endpoint,
            lastSeenAt: pushDevices.lastSeenAt,
            createdAt: pushDevices.createdAt,
          })
          .from(pushDevices)
          .where(eq(pushDevices.userId, userId))
      ).map((row) => ({ kind: 'device', ...row }));
      return;
    }
    yield (
      await this.db
        .select()
        .from(recordSubscriptions)
        .where(eq(recordSubscriptions.subscriber, key))
    ).map((row) => ({ kind: 'subscription', ...row }));
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.recipient, key),
            cursor ? lt(notifications.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(notifications.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows.map((row) => ({ kind: 'notification', ...row }));
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key, userId, tenantId }: PersonalDataSubject) {
    if (tenantId === null) {
      await this.db
        .delete(notificationPreferences)
        .where(eq(notificationPreferences.recipient, key));
      await this.db.delete(pushDevices).where(eq(pushDevices.userId, userId));
      return;
    }
    await this.db.delete(notifications).where(eq(notifications.recipient, key));
    await this.db
      .delete(recordSubscriptions)
      .where(eq(recordSubscriptions.subscriber, key));
  }
}
