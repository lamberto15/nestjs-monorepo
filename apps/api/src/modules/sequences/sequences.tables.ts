import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/**
 * Counters for human-readable numbers (`INV-2026-00042`): one row per
 * sequence and scope (a unit, a year), its last value. A row is locked
 * for the transaction that takes a number, so numbers are gapless: a
 * rollback takes none. Per tenant: each numbers its own series.
 */
export const sequences = tenantTable(
  'sequences',
  {
    id: uuidPk(),
    /** What is numbered: `invoice`, `note`. */
    name: text('name').notNull(),
    /** Numbered apart: per unit, per year, or '' for one series. */
    scope: text('scope').notNull().default(''),
    value: bigint('value', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sequences_name_scope_idx').on(t.tenantId, t.name, t.scope),
  ],
);

/** A condition on a create body's field (`{ field: 'region', op: 'eq', value: 'EU' }`). */
export interface NamingCondition {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
  value: string | number | boolean;
}

/**
 * The number formats a tenant's administrators define for a numbered
 * subject (`INV-.YYYY.-.#####`, naming-pattern.ts), Frappe's naming
 * series: several per subject, one its default. The counters live in
 * `sequences`, keyed by what a pattern prints around its counter.
 */
export const namingSeries = tenantTable(
  'naming_series',
  {
    id: uuidPk(),
    /** What it numbers: a permission subject, `Note`. */
    subject: text('subject').notNull(),
    pattern: text('pattern').notNull(),
    /** What people pick it by: `Credit notes`. */
    label: text('label'),
    /** The series a new record takes when its body names none and no series' conditions match it. */
    isDefault: boolean('is_default').notNull().default(false),
    /** The record's date field its date parts and FY are taken from (`invoiceDate`); null: the moment it is created. */
    dateField: text('date_field'),
    /**
     * Frappe's Document Naming Rule: a record whose body names no series
     * takes the first series, by priority, whose conditions all hold for
     * it. None: only by default or by name.
     */
    conditions: jsonb('conditions')
      .$type<NamingCondition[]>()
      .notNull()
      .default([]),
    /** Higher first, among the series whose conditions hold. */
    priority: integer('priority').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('naming_series_pattern_idx').on(
      t.tenantId,
      t.subject,
      t.pattern,
    ),
    // One default per subject.
    uniqueIndex('naming_series_default_idx')
      .on(t.tenantId, t.subject)
      .where(sql`${t.isDefault}`),
  ],
);
