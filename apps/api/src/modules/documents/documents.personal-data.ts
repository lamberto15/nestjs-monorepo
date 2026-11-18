import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { documents } from './documents.tables.js';

/** Who a document is asked by once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * The documents the person asked for: in their export (without the run's
 * secret). At the deletion they stay with their records, asked for by nobody.
 */
@PersonalData({ name: 'documents', scopes: ['tenant'] })
@Injectable()
export class DocumentsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.requestedBy, key),
            cursor ? lt(documents.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(documents.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows.map(({ runToken: _token, ...row }) => row);
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .update(documents)
      .set({ requestedBy: ANONYMIZED })
      .where(eq(documents.requestedBy, key));
  }
}
