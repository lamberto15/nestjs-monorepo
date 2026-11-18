import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { recentRecords } from './recents.tables.js';

/** The person's recently viewed records: in their export, deleted with their account. */
@PersonalData({ name: 'recents', scopes: ['tenant'] })
@Injectable()
export class RecentsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select()
      .from(recentRecords)
      .where(eq(recentRecords.owner, key))
      .orderBy(desc(recentRecords.viewedAt));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db.delete(recentRecords).where(eq(recentRecords.owner, key));
  }
}
