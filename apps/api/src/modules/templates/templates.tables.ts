import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { organizationalUnits } from '../../iam/organization/organization.tables.js';

/** Who sees a record template: its owner alone, the current members of a unit, or the whole tenant. */
export const TEMPLATE_VISIBILITIES = ['private', 'unit', 'tenant'] as const;
export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

/**
 * Record templates: values to prefill a new record of a subject
 * (`POST /v1/<path>`), kept under a name. A template only holds values of
 * the subject's create schema; it is previewed (`GET /v1/templates/{id}/preview`)
 * and the client then creates the record through the subject's own route,
 * which validates and authorizes it as any create.
 */
export const recordTemplates = tenantTable(
  'record_templates',
  {
    id: uuidPk(),
    /** The record's permission subject: `Note`. */
    subject: text('subject').notNull(),
    name: text('name').notNull(),
    visibility: text('visibility').$type<TemplateVisibility>().notNull(),
    /** Whose it is: `user:<id>` or `client:<id>`; `anonymous` once its owner's account is gone. */
    owner: text('owner').notNull(),
    /** The organizational unit a `unit` template is shared with; null otherwise. */
    unitId: uuid('unit_id'),
    /**
     * What the name is unique within (case-insensitively, per subject): the
     * owner's key for a private template, `unit:<id>`, or `tenant`.
     */
    scope: text('scope').notNull(),
    /** The create body's values to prefill, as the create route takes them. */
    values: jsonb('values')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('record_templates_name_idx').on(
      t.tenantId,
      t.subject,
      t.scope,
      sql`lower(${t.name})`,
    ),
    index('record_templates_owner_idx').on(t.owner, t.subject),
    index('record_templates_unit_idx').on(t.unitId),
    check(
      'record_templates_unit_check',
      sql`(${t.visibility} = 'unit') = (${t.unitId} is not null)`,
    ),
    check(
      'record_templates_visibility_check',
      sql`${t.visibility} in ('private', 'unit', 'tenant')`,
    ),
    // A unit with templates shared with it can't be deleted (409 `unit_not_empty`).
    tenantReference(
      'record_templates_unit_fk',
      [t.tenantId, t.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
      'restrict',
    ),
  ],
);

export type RecordTemplateRow = typeof recordTemplates.$inferSelect;
