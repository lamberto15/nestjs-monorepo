import { Injectable } from '@nestjs/common';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { NotificationsRepository } from './notifications.repository.js';
import { SubscriptionsRepository } from './subscriptions.repository.js';

/**
 * What notifications hold about the person. In each tenant: their
 * notifications and the records they watch. In their account: their
 * preferences and their push devices (without the keys that reach them).
 * All of it goes with their account.
 */
@PersonalData({ name: 'notifications', scopes: ['tenant', 'account'] })
@Injectable()
export class NotificationsPersonalData implements PersonalDataSection {
  constructor(
    private readonly repository: NotificationsRepository,
    private readonly subscriptions: SubscriptionsRepository,
  ) {}

  async *rows({ key, userId, tenantId }: PersonalDataSubject) {
    if (tenantId === null) {
      yield (await this.repository.preferencesOf(key)).map((row) => ({
        kind: 'preferences',
        ...row,
      }));
      yield (await this.repository.deviceSummariesOf(userId)).map((row) => ({
        kind: 'device',
        ...row,
      }));
      return;
    }
    yield (await this.subscriptions.of(key)).map((row) => ({
      kind: 'subscription',
      ...row,
    }));
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.repository.notificationsOf(key, cursor, 1000);
      if (rows.length === 0) return;
      yield rows.map((row) => ({ kind: 'notification', ...row }));
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key, userId, tenantId }: PersonalDataSubject) {
    if (tenantId === null) {
      await this.repository.deletePreferencesOf(key);
      await this.repository.deleteDevicesOf(userId);
      return;
    }
    await this.repository.deleteNotificationsOf(key);
    await this.subscriptions.deleteOf(key);
  }
}
