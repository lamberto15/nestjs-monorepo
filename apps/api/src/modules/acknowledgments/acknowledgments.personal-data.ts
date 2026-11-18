import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { recordAcknowledgments } from './acknowledgments.tables.js';

/** The acknowledgments asked of the person: in their export, deleted with their account (the audit log keeps the answers, by key). */
@PersonalData({ name: 'acknowledgments', scopes: ['tenant'] })
@Injectable()
export class AcknowledgmentsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select()
      .from(recordAcknowledgments)
      .where(eq(recordAcknowledgments.recipient, key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .delete(recordAcknowledgments)
      .where(eq(recordAcknowledgments.recipient, key));
  }
}
