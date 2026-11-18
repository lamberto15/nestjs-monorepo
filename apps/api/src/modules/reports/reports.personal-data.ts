import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { reportSchedules } from './reports.tables.js';

/** The person's report schedules: in their export, deleted with their account (the addresses they mail are theirs to give). */
@PersonalData({ name: 'reports', scopes: ['tenant'] })
@Injectable()
export class ReportsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select()
      .from(reportSchedules)
      .where(eq(reportSchedules.owner, key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db.delete(reportSchedules).where(eq(reportSchedules.owner, key));
  }
}
