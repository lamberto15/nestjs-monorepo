import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { revisions } from './revisions.tables.js';

/** Who made a change once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * Revisions are the records' history, not the person's data: nothing to
 * export. At the deletion they stay, their author becomes `anonymized`.
 */
@PersonalData({ name: 'revisions', scopes: ['tenant'] })
@Injectable()
export class RevisionsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .update(revisions)
      .set({ changedBy: ANONYMIZED })
      .where(eq(revisions.changedBy, key));
  }
}
