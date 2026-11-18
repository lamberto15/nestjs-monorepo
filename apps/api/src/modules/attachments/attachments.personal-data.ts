import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { publicRenditions } from './attachments.renditions.js';
import { attachments } from './attachments.tables.js';

/** Who a file is uploaded by once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * The files the person uploaded: their rows in the export, not the files.
 * At the deletion the files stay with their records, uploaded by nobody.
 */
@PersonalData({ name: 'attachments', scopes: ['tenant'] })
@Injectable()
export class AttachmentsPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.uploadedBy, key),
            cursor ? lt(attachments.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(attachments.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows.map(({ key: _file, renditions, ...row }) => ({
        ...row,
        renditions: publicRenditions(renditions),
      }));
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .update(attachments)
      .set({ uploadedBy: ANONYMIZED })
      .where(eq(attachments.uploadedBy, key));
  }
}
