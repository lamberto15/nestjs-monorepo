import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { recordTemplates } from './templates.tables.js';

/**
 * The record templates the person owns: in their export. At the deletion the private
 * ones go; shared ones stay for the unit or tenant, ownerless (`anonymous`),
 * changeable by whoever manages them.
 */
@PersonalData({ name: 'templates', scopes: ['tenant'] })
@Injectable()
export class TemplatesPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select()
      .from(recordTemplates)
      .where(eq(recordTemplates.owner, key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .delete(recordTemplates)
      .where(
        and(
          eq(recordTemplates.owner, key),
          eq(recordTemplates.visibility, 'private'),
        ),
      );
    await this.db
      .update(recordTemplates)
      .set({ owner: 'anonymous' })
      .where(eq(recordTemplates.owner, key));
  }
}
