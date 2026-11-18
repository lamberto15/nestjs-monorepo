import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { aiRuns } from './ai.tables.js';

/** Who a run is asked by once its person is gone. */
const ANONYMIZED = 'anonymized';

/**
 * The person's AI runs (no prompts, no outputs are stored): in their export.
 * At the deletion the usage stays (it counts toward the quota), asked for by
 * nobody.
 */
@PersonalData({ name: 'ai', scopes: ['tenant'] })
@Injectable()
export class AiPersonalData implements PersonalDataSection {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async *rows({ key }: PersonalDataSubject) {
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.db
        .select()
        .from(aiRuns)
        .where(
          and(
            eq(aiRuns.requestedBy, key),
            cursor ? lt(aiRuns.id, cursor) : undefined,
          ),
        )
        .orderBy(desc(aiRuns.id))
        .limit(1000);
      if (rows.length === 0) return;
      yield rows;
      cursor = rows[rows.length - 1]!.id;
    }
  }

  async erase({ key }: PersonalDataSubject) {
    await this.db
      .update(aiRuns)
      .set({ requestedBy: ANONYMIZED })
      .where(eq(aiRuns.requestedBy, key));
  }
}
