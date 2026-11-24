import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, text } from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import { tenantTable } from '../../core/tenancy/tenant-tables.js';
import type { ReportSchedule } from './report-time.js';

/**
 * Scheduled reports: an export (a record's list, a format, its filters and
 * sort) run for its owner on a schedule in a time zone, its file mailed to
 * the recipients. The runner starts the due ones (`next_run_at`) every hour.
 */
export const reportSchedules = tenantTable(
  'report_schedules',
  {
    id: uuidPk(),
    /** Whose report it is, and as whom it runs: `user:<id>` or `client:<id>`. */
    owner: text('owner').notNull(),
    name: text('name').notNull(),
    /** The export's name: a record's path (`invoices`). */
    exporter: text('exporter').notNull(),
    format: text('format').notNull(),
    /** The list filters, as its list route takes them. */
    filters: jsonb('filters')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /** The list's order (`-createdAt,title`); null: newest first. */
    sort: text('sort'),
    /** The IANA zone of the schedule's hours and of the file's dates. */
    timezone: text('timezone').notNull(),
    schedule: jsonb('schedule').$type<ReportSchedule>().notNull(),
    recipients: text('recipients').array().notNull(),
    active: boolean('active').notNull().default(true),
    lastRunAt: at('last_run_at'),
    /** The last run's transfer (`GET /v1/data/transfers/{id}`). */
    lastTransferId: text('last_transfer_id'),
    /** `completed` or `failed`, once the last run's export ended. */
    lastStatus: text('last_status').$type<'completed' | 'failed'>(),
    nextRunAt: at('next_run_at').notNull(),
    ...timestamps(),
  },
  (t) => [
    index('report_schedules_owner_idx').on(t.tenantId, t.owner, t.id),
    // Due time first: the runner's query across tenants (dueTenants) reads
    // it by time, and a tenant's own (due) filters the few due rows by
    // tenant inside it. One index for both: no second one to write.
    index('report_schedules_next_run_at_idx')
      .on(t.nextRunAt, t.tenantId)
      .where(sql`${t.active}`),
  ],
);

export type ReportScheduleRow = typeof reportSchedules.$inferSelect;
