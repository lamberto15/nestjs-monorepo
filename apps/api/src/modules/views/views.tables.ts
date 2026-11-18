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

/** Who sees a saved view: its owner alone, the current members of a unit, or the whole tenant. */
export const VIEW_VISIBILITIES = ['private', 'unit', 'tenant'] as const;
export type ViewVisibility = (typeof VIEW_VISIBILITIES)[number];

/**
 * Saved views: a list's filters, sort and columns kept under a name, for
 * any list `GET /v1/lists/{subject}` describes. `query` holds the list
 * query's own parameters (`status`, `title.contains`, `filter`, `sort`),
 * `columns` the item fields to show (`fields=`). Both are validated against
 * the list when saved and again when applied.
 */
export const savedViews = tenantTable(
  'saved_views',
  {
    id: uuidPk(),
    /** The list's permission subject: `Note`. */
    subject: text('subject').notNull(),
    name: text('name').notNull(),
    visibility: text('visibility').$type<ViewVisibility>().notNull(),
    /** Whose it is: `user:<id>` or `client:<id>`; `anonymous` once its owner's account is gone. */
    owner: text('owner').notNull(),
    /** The organizational unit a `unit` view is shared with; null otherwise. */
    unitId: uuid('unit_id'),
    /**
     * What the name is unique within (case-insensitively, per subject): the
     * owner's key for a private view, `unit:<id>`, or `tenant`.
     */
    scope: text('scope').notNull(),
    /** The list's query parameters, as its route takes them. */
    query: jsonb('query').$type<Record<string, string>>().notNull().default({}),
    /** The item fields to show, in order; null: the list's own. */
    columns: jsonb('columns').$type<string[] | null>(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('saved_views_name_idx').on(
      t.tenantId,
      t.subject,
      t.scope,
      sql`lower(${t.name})`,
    ),
    index('saved_views_owner_idx').on(t.owner, t.subject),
    index('saved_views_unit_idx').on(t.unitId),
    check(
      'saved_views_unit_check',
      sql`(${t.visibility} = 'unit') = (${t.unitId} is not null)`,
    ),
    check(
      'saved_views_visibility_check',
      sql`${t.visibility} in ('private', 'unit', 'tenant')`,
    ),
    // A unit with views shared with it can't be deleted (409 `unit_not_empty`).
    tenantReference(
      'saved_views_unit_fk',
      [t.tenantId, t.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
      'restrict',
    ),
  ],
);

export type SavedViewRow = typeof savedViews.$inferSelect;
