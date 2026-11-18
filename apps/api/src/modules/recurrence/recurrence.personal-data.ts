import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { recordSchedules } from './recurrence.tables.js';

/** The person's record schedules: in their export, deleted with their account (what they would create is theirs to give). */
@PersonalData({ name: 'record-schedules', scopes: ['tenant'] })
@Injectable()
export class RecurrencePersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select()
      .from(recordSchedules)
      .where(eq(recordSchedules.owner, key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db.delete(recordSchedules).where(eq(recordSchedules.owner, key));
  }
}
