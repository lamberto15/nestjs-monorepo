import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { inArray, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { auditLog } from './audit.tables.js';

/**
 * The queries of the audit log, in the ambient transaction
 * (`@InjectTransaction()`) and the current tenant; `db` names another
 * transaction, as AuditService.record() lets its callers do.
 */
@Injectable()
export class AuditRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async insert(values: typeof auditLog.$inferInsert, db: Database = this.db) {
    await db.insert(auditLog).values(values);
  }

  /** Deletes up to `limit` entries older than `before`; returns their ids. */
  deleteOlderThan(before: Date, limit: number) {
    const old = this.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(lt(auditLog.at, before))
      .limit(limit);
    return this.db
      .delete(auditLog)
      .where(inArray(auditLog.id, old))
      .returning({ id: auditLog.id });
  }
}
