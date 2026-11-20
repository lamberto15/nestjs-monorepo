import { isNull, sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { at, timestamps, uuidPk } from '../../core/database/columns.js';
import {
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { memberships } from '../auth/auth.tables.js';

/** The kinds of organizational unit: labels of one tree, never a grant. */
export const UNIT_TYPES = ['division', 'department', 'team'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

/** What a member is in a unit: a lead is context for the unit conditions, never a grant by itself. */
export const UNIT_ROLES = ['member', 'lead'] as const;
export type UnitRole = (typeof UNIT_ROLES)[number];

/**
 * The organization structure of a tenant: one tree of units (divisions,
 * departments, teams, in any order, at any depth). Users belong to units;
 * records can carry the unit that owns them, and the unit conditions
 * (`inMyUnits`, `inMyUnitsAndBelow`, `inMyUnitsAndAbove`, `inUnitsILeadAndBelow`) grant what is
 * in them. A unit's name is unique among its siblings, ignoring case.
 */
export const organizationalUnits = tenantTable(
  'organizational_units',
  {
    id: uuidPk(),
    type: text('type', { enum: UNIT_TYPES }).notNull().default('team'),
    name: text('name').notNull(),
    /** Null: a top-level unit. The closure table holds every path. */
    parentId: uuid('parent_id'),
    ...timestamps(),
  },
  (t) => [
    index('organizational_units_parent_id_idx').on(t.parentId),
    // A top-level unit's parent counts as one value (the zero uuid), so two
    // roots can't share a name either.
    uniqueIndex('organizational_units_sibling_name_idx').on(
      t.tenantId,
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
    check(
      'organizational_units_type_check',
      sql`${t.type} in ('division', 'department', 'team')`,
    ),
    tenantReference(
      'organizational_units_parent_fk',
      [t.tenantId, t.parentId],
      [t.tenantId, t.id],
      'restrict',
    ),
  ],
  { referenced: true },
);

/**
 * Every (ancestor, descendant) pair of units, a unit being its own
 * ancestor at depth 0: "under X" at any depth in one indexed lookup, no
 * recursive query (tree.ts).
 */
export const organizationalUnitClosure = tenantTable(
  'organizational_unit_closure',
  {
    ancestorId: uuid('ancestor_id').notNull(),
    descendantId: uuid('descendant_id').notNull(),
    depth: integer('depth').notNull(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('organizational_unit_closure_tenant_idx').on(t.tenantId),
    primaryKey({ columns: [t.ancestorId, t.descendantId] }),
    index('organizational_unit_closure_descendant_idx').on(t.descendantId),
    tenantReference(
      'organizational_unit_closure_ancestor_fk',
      [t.tenantId, t.ancestorId],
      [organizationalUnits.tenantId, organizationalUnits.id],
    ),
    tenantReference(
      'organizational_unit_closure_descendant_fk',
      [t.tenantId, t.descendantId],
      [organizationalUnits.tenantId, organizationalUnits.id],
    ),
  ],
);

/**
 * Who belongs to which unit, as a member or its lead, from `validFrom`
 * until `validTo` (null: open-ended): an ended membership stays, so "who
 * was in Finance when this was approved" has an answer, and a re-org can
 * be dated ahead. At most one open membership per unit and user.
 * Membership of a unit says nothing of its parent.
 */
export const organizationalUnitMemberships = tenantTable(
  'organizational_unit_memberships',
  {
    id: uuidPk(),
    unitId: uuid('unit_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role', { enum: UNIT_ROLES }).notNull().default('member'),
    validFrom: at('valid_from').notNull().defaultNow(),
    validTo: at('valid_to'),
    ...timestamps(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('organizational_unit_memberships_tenant_idx').on(t.tenantId),
    uniqueIndex('organizational_unit_memberships_open_idx')
      .on(t.tenantId, t.unitId, t.userId)
      .where(isNull(t.validTo)),
    index('organizational_unit_memberships_user_idx').on(t.userId, t.validFrom),
    index('organizational_unit_memberships_unit_idx').on(t.unitId),
    check(
      'organizational_unit_memberships_role_check',
      sql`${t.role} in ('member', 'lead')`,
    ),
    check(
      'organizational_unit_memberships_period_check',
      sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`,
    ),
    foreignKey({
      name: 'organizational_unit_memberships_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    tenantReference(
      'organizational_unit_memberships_unit_fk',
      [t.tenantId, t.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
    ),
  ],
);
