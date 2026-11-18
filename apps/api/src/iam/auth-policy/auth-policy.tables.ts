import {
  boolean,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { timestamps } from '../../core/database/columns.js';
import {
  globalTable,
  tenantReference,
  tenantTable,
} from '../../core/tenancy/tenant-tables.js';
import { organizationalUnits } from '../organization/organization.tables.js';

/**
 * A tenant's sign-in policy, one row per tenant that chose any (none: the
 * deployment's environment alone). Null: no choice. Global with the tenant
 * named (globalTable()): it is read before a request has a tenant (a
 * sign-in, a reset link, a token refresh), inside an account's own
 * transactions, and for every tenant an account belongs to (a password is
 * the account's). Gone with the tenant (cascade).
 */
export const authPolicies = globalTable(
  'auth_policies',
  {
    /** Every member must have two-factor sign-in (AUTH_MFA on). */
    requireMfa: boolean('require_mfa').notNull().default(false),
    /** The minimum length of a new password (12 to 64). */
    passwordMinLength: integer('password_min_length'),
    /** How many of an account's last passwords may not be reused (0 to 24). */
    passwordHistory: integer('password_history'),
    /** Minutes without a request after which a session ends, under SESSION_IDLE_MINUTES. */
    sessionIdleMinutes: integer('session_idle_minutes'),
    /** Hours after the sign-in when a session ends, under SESSION_MAX_HOURS. */
    sessionMaxHours: integer('session_max_hours'),
    /** Off: the operators may not open this tenant with a break-glass grant. */
    allowBreakGlass: boolean('allow_break_glass').notNull().default(true),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.tenantId] })],
);

/**
 * A unit's own requirement of two-factor sign-in: it holds for the unit's
 * members and, down the tree, for the members of the units under it. Only
 * a unit that requires it has a row. Gone with the unit (cascade).
 */
export const authPolicyUnits = tenantTable(
  'auth_policy_units',
  {
    unitId: uuid('unit_id').notNull(),
    requireMfa: boolean('require_mfa').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.unitId] }),
    tenantReference(
      'auth_policy_units_unit_fk',
      [t.tenantId, t.unitId],
      [organizationalUnits.tenantId, organizationalUnits.id],
    ),
  ],
);

/**
 * What the deployment's operators require of every tenant: one row (id 1),
 * in no tenant. A tenant can't go below it: two-factor is required of a
 * member when the platform, their tenant or one of their units requires it.
 */
export const authPolicyPlatform = pgTable(
  'auth_policy_platform',
  {
    id: integer('id').primaryKey().default(1),
    requireMfa: boolean('require_mfa').notNull().default(false),
    updatedBy: text('updated_by').notNull(),
    ...timestamps(),
  },
  (t) => [check('auth_policy_platform_single_row', sql`${t.id} = 1`)],
);
