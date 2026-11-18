import { sql } from 'drizzle-orm';
import { index, integer, jsonb, text, uuid } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';

/** An action as a rule stores it: its name and its parameters. */
export type StoredAction = { type: string } & Record<string, unknown>;

/** One action as a run (or a simulation) found it: allowed as the rule's owner, or why not. */
export interface RunAction {
  type: string;
  allowed: boolean;
  reason: string | null;
  detail: string;
}

/**
 * A tenant's automation rules: when a record of `subject` is created or
 * changed and the condition holds, the actions run, as `owner` (who
 * activated it). A draft or a disabled rule runs nothing; a change of what
 * it does is a new version and a draft again.
 */
export const automationRules = tenantTable(
  'automation_rules',
  {
    id: uuidPk(),
    name: text('name').notNull(),
    /** The records' permission subject: `Invoice`. */
    subject: text('subject').notNull(),
    trigger: text('trigger').$type<'created' | 'updated'>().notNull(),
    /** With `updated`: only when this field changed. */
    field: text('field'),
    /** An expression (modules/expressions) on the record; null: every record. */
    condition: text('condition'),
    actions: jsonb('actions').$type<StoredAction[]>().notNull(),
    status: text('status')
      .$type<'draft' | 'active' | 'disabled'>()
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(1),
    /** `user:<id>` of who activated it: it runs with their permissions, as they are at each run. */
    owner: text('owner'),
    activatedAt: at('activated_at'),
    /** `manual`, `owner_inactive`, `run_limit`, `failing`, `subject_gone`. */
    disabledReason: text('disabled_reason'),
    /** Failed runs in a row: at MAX_FAILURES it is disabled. */
    failures: integer('failures').notNull().default(0),
    lastRunAt: at('last_run_at'),
    lastStatus: text('last_status').$type<'succeeded' | 'failed'>(),
    ...timestamps(),
  },
  (t) => [
    // What every write of a record asks: the active rules of its subject.
    index('automation_rules_active_idx')
      .on(t.tenantId, t.subject)
      .where(sql`${t.status} = 'active'`),
  ],
  { referenced: true },
);

export type AutomationRule = typeof automationRules.$inferSelect;

/** The run log: what each run of a rule did, or why it failed. Its runs go with the rule. */
export const automationRuns = tenantTable(
  'automation_runs',
  {
    id: uuidPk(),
    ruleId: uuid('rule_id').notNull(),
    ruleVersion: integer('rule_version').notNull(),
    recordId: uuid('record_id').notNull(),
    status: text('status').$type<'succeeded' | 'failed'>().notNull(),
    actions: jsonb('actions').$type<RunAction[]>().notNull(),
    error: text('error'),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('automation_runs_rule_idx').on(t.tenantId, t.ruleId, t.createdAt),
    tenantReference(
      'automation_runs_rule_fk',
      [t.tenantId, t.ruleId],
      [automationRules.tenantId, automationRules.id],
    ),
  ],
);

export type AutomationRun = typeof automationRuns.$inferSelect;
