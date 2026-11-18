import { isNull } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';

/** What a finding says is wrong with a record: a rule it breaks, or a built-in check. */
export const QUALITY_CHECKS = [
  'missing',
  'reference',
  'duplicate',
  'rule',
] as const;
export type QualityCheck = (typeof QUALITY_CHECKS)[number];
/** An error is wrong as it stands; a suggestion may be right as it is. */
export const QUALITY_SEVERITIES = ['error', 'suggestion'] as const;
export type QualitySeverity = (typeof QUALITY_SEVERITIES)[number];

/**
 * One problem a scan found on one record: there while it holds (a scan or a
 * recheck that no longer finds it deletes it), dismissed by someone who
 * decided it is right as it is (and stays so while it holds). Nothing here
 * ever changes the record.
 */
export const dataQualityFindings = tenantTable(
  'data_quality_findings',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    recordId: uuid('record_id').notNull(),
    check: text('check').$type<QualityCheck>().notNull(),
    /** The record's field it is about; a rule's name for `rule`. */
    field: text('field').notNull(),
    severity: text('severity').$type<QualitySeverity>().notNull(),
    /** What helps to act on it: the record referred to, the other record with the same value, a rule's message. */
    detail: jsonb('detail').$type<Record<string, string>>(),
    /** When a scan or a recheck last found it. */
    checkedAt: at('checked_at').notNull().defaultNow(),
    dismissedAt: at('dismissed_at'),
    /** `user:<id>` of who dismissed it. */
    dismissedBy: text('dismissed_by'),
    ...timestamps(),
  },
  (t) => [
    // The open findings of a subject, newest first: one page of a range.
    index('data_quality_findings_open_idx')
      .on(t.tenantId, t.subject, t.id.desc().nullsFirst())
      .where(isNull(t.dismissedAt)),
    uniqueIndex('data_quality_findings_key_idx').on(
      t.tenantId,
      t.subject,
      t.recordId,
      t.check,
      t.field,
    ),
  ],
);

export type DataQualityFindingRow = typeof dataQualityFindings.$inferSelect;

/** A scan of the tenant's records, its progress and how it ended. */
export const dataQualityScans = tenantTable(
  'data_quality_scans',
  {
    id: uuidPk(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'failed'>()
      .notNull()
      .default('queued'),
    /** The records to check when it started, and those checked so far. */
    total: integer('total').notNull().default(0),
    scanned: integer('scanned').notNull().default(0),
    /** Open findings once it completed. */
    findings: integer('findings'),
    /** `user:<id>` or `client:<id>` of who started it. */
    startedBy: text('started_by').notNull(),
    finishedAt: at('finished_at'),
    ...timestamps(),
  },
  (t) => [index('data_quality_scans_tenant_idx').on(t.tenantId, t.createdAt)],
);

export type DataQualityScanRow = typeof dataQualityScans.$inferSelect;
