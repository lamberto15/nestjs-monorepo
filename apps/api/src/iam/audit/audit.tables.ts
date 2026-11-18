import { index, jsonb, text, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { at, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * The sign-in log's actions (SIGN_IN_ACTIONS) as the partial indexes write
 * them: literals, as an index predicate takes no parameter;
 * audit.service.spec.ts keeps the two in step.
 */
export const signInEntries = sql`action in ('member.signed-in', 'member.sign-in-failed')`;

/**
 * Who did what: sign-ins, access changes and sensitive actions. Append-only.
 * Per tenant (the tenant of the work that recorded it); an account's own
 * entries made outside any tenant (sign-ins, failed sign-ins) have none,
 * and only work outside every tenant reads them (`nullRows: 'outside'`).
 */
export const auditLog = tenantTable(
  'audit_log',
  {
    id: uuidPk(),
    at: at('at').notNull().defaultNow(),
    /** `user:<id>`, `client:<id>`, `system:<job>` or `anonymous`. */
    actor: text('actor').notNull(),
    /** How the actor was shown when the entry was written (an email, a client's name). */
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>(),
    ip: text('ip'),
    /** The run (a bulk run) the entry is part of: inAuditRun(). */
    runId: uuid('run_id'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_tenant_at_id_idx').on(
      t.tenantId,
      t.at.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('audit_log_tenant_id_id_idx').on(t.tenantId, t.id),
    // One actor's entries of one kind, recent first: a sign-in looks up the account's known devices.
    index('audit_log_actor_action_at_idx').on(t.actor, t.action, t.at),
    // One record's history, newest first.
    index('audit_log_target_id_id_idx').on(t.targetId, t.id),
    // One run's entries (the audit screen expands a run).
    index('audit_log_tenant_run_id_idx').on(t.tenantId, t.runId, t.id),
    // One actor's entries in id order.
    index('audit_log_actor_id_idx').on(t.actor, t.id),
    // An action within the tenant, newest first.
    index('audit_log_tenant_action_id_idx').on(t.tenantId, t.action, t.id),
    // The sign-in log is a few rows among millions: these hold the
    // sign-ins alone, in both orders a list sorts by.
    index('audit_log_sign_ins_id_idx')
      .on(t.tenantId, t.id)
      .where(signInEntries),
    index('audit_log_sign_ins_at_idx')
      .on(t.tenantId, t.at.desc().nullsFirst(), t.id.desc().nullsFirst())
      .where(signInEntries),
  ],
  { nullRows: 'outside' },
);
