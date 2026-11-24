import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { approvalPolicies } from './approvals.tables.js';

/** The stored policy versions. The transaction and the tenant are the caller's. */
@Injectable()
export class ApprovalPoliciesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The action's newest version, or none. */
  async latest(key: string) {
    const [latest] = await this.db
      .select()
      .from(approvalPolicies)
      .where(eq(approvalPolicies.key, key))
      .orderBy(desc(approvalPolicies.version))
      .limit(1);
    return latest;
  }

  /** A new version; a version taken meanwhile is a unique violation. */
  async insert(values: typeof approvalPolicies.$inferInsert) {
    await this.db.insert(approvalPolicies).values(values);
  }
}
