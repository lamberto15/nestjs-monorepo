import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { settingOverrides } from './settings.tables.js';

/** The settings the person set for themselves: in their export, deleted with their account. */
@PersonalData({ name: 'settings', scopes: ['tenant'] })
@Injectable()
export class SettingsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select({
        id: settingOverrides.id,
        key: settingOverrides.key,
        value: settingOverrides.value,
        updatedAt: settingOverrides.updatedAt,
      })
      .from(settingOverrides)
      .where(this.own(key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db.delete(settingOverrides).where(this.own(key));
  }

  private own(key: string) {
    return and(
      eq(settingOverrides.scope, 'user'),
      eq(settingOverrides.scopeId, key),
    );
  }
}
