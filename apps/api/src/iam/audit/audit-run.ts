import { eq } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { ClsServiceManager } from 'nestjs-cls';
import { auditLog } from './audit.tables.js';

const AUDIT_RUN = 'auditRun';

/**
 * Runs `work` as part of a run (a bulk run): every audit entry written
 * inside carries its id (`audit_log.run_id`), and what reacts to the
 * changes (a watcher's notification) can tell them apart from single edits.
 * nestjs-cls, as the tenant scope: a nested (`inherit`) context, so the
 * caller's own context is left as it was.
 */
export function inAuditRun<T>(runId: string, work: () => Promise<T>) {
  const cls = ClsServiceManager.getClsService();
  return cls.run({ ifNested: 'inherit' }, async () => {
    cls.set(AUDIT_RUN, runId);
    return await work();
  });
}

/** The id of the run the current work is part of, or undefined. */
export function currentAuditRun(): string | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive()
    ? (cls.get(AUDIT_RUN) as string | undefined)
    : undefined;
}

/**
 * The ids of the records a run changed (the targets of its entries), as a
 * subquery: a record list's `?bulkRun=<id>`, the page a run's notification
 * opens. Row-level security keeps it to the tenant.
 */
export const auditRunTargets = (runId: string) =>
  new QueryBuilder()
    .select({ id: auditLog.targetId })
    .from(auditLog)
    .where(eq(auditLog.runId, runId));
