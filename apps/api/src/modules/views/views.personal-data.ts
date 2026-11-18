import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { savedViews } from './views.tables.js';

/**
 * The saved views the person owns: in their export. At the deletion the private
 * ones go; shared ones stay for the unit or tenant, ownerless (`anonymous`),
 * changeable by whoever manages them.
 */
@PersonalData({ name: 'views', scopes: ['tenant'] })
@Injectable()
export class ViewsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db.select().from(savedViews).where(eq(savedViews.owner, key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .delete(savedViews)
      .where(
        and(eq(savedViews.owner, key), eq(savedViews.visibility, 'private')),
      );
    await this.db
      .update(savedViews)
      .set({ owner: 'anonymous' })
      .where(eq(savedViews.owner, key));
  }
}
