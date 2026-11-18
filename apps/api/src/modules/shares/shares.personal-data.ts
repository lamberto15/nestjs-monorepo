import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { recordShares } from './shares.tables.js';

/** Who a link was made by once its person is gone. */
const ANONYMIZED = 'anonymous';

/**
 * The links the person made (not their secrets): in their export. At the
 * deletion the working ones are revoked and every one loses their name.
 */
@PersonalData({ name: 'shares', scopes: ['tenant'] })
@Injectable()
export class SharesPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async rows({ key }: PersonalDataSubject) {
    return this.db
      .select({
        id: recordShares.id,
        subject: recordShares.subject,
        recordId: recordShares.recordId,
        fields: recordShares.fields,
        files: recordShares.files,
        recipientEmail: recordShares.recipientEmail,
        expiresAt: recordShares.expiresAt,
        revokedAt: recordShares.revokedAt,
        views: recordShares.views,
        createdAt: recordShares.createdAt,
      })
      .from(recordShares)
      .where(eq(recordShares.createdBy, key));
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .update(recordShares)
      .set({ revokedAt: new Date(), revokedBy: ANONYMIZED })
      .where(
        and(eq(recordShares.createdBy, key), isNull(recordShares.revokedAt)),
      );
    await this.db
      .update(recordShares)
      .set({ createdBy: ANONYMIZED })
      .where(eq(recordShares.createdBy, key));
    await this.db
      .update(recordShares)
      .set({ revokedBy: ANONYMIZED })
      .where(eq(recordShares.revokedBy, key));
  }
}
