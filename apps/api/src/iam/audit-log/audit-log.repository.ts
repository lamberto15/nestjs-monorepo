import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, type SQL } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { auditLog, signInEntries } from '../audit/audit.tables.js';
import { AUDIT_LIST, SIGN_IN_LIST } from './audit.lists.js';

/** The pages of iam/audit's log, the tenant's by row-level security. */
@Injectable()
export class AuditLogRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of the log, newest first unless the query sorts. */
  entries(query: ListQuery) {
    return this.page(query, AUDIT_LIST.where(query));
  }

  /** A page of the sign-in entries (`signInEntries`, their partial indexes). */
  signIns(query: ListQuery) {
    return this.page(query, and(signInEntries, SIGN_IN_LIST.where(query)));
  }

  private async page(query: ListQuery, where?: SQL) {
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(and(where, afterCursor(auditLog.id, query)))
        .orderBy(...pageOrder(auditLog.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, auditLog, where, query),
    ]);
    return toPage(rows, query, total);
  }
}
