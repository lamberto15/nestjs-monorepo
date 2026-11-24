import { gt, isNull, or } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  jsonb,
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
import { apiClients, memberships } from '../auth/auth.tables.js';
import type { PermissionInput } from './permissions.js';

/**
 * A tenant's roles: sets of permissions its administrators edit through
 * the access API. Administrator is built in (`system`, `all.manage`);
 * the seed roles (`key`) are made with the tenant and editable after.
 */
export const roles = tenantTable(
  'roles',
  {
    id: uuidPk(),
    /** The code's name of a built-in or seeded role (`administrator`, `editor`); null for roles made in the API. */
    key: text('key'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Built in: never edited nor deleted. */
    system: boolean('system').notNull().default(false),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('roles_tenant_key_idx').on(t.tenantId, t.key),
    uniqueIndex('roles_tenant_name_idx').on(t.tenantId, t.name),
  ],
  { referenced: true },
);

/** A role's permissions: an action on a subject, its conditions and fields, as the catalog declares them. */
export const rolePermissions = tenantTable(
  'role_permissions',
  {
    id: uuidPk(),
    roleId: uuid('role_id').notNull(),
    subject: text('subject').notNull(),
    action: text('action').notNull(),
    conditions: jsonb('conditions')
      .$type<PermissionInput['conditions']>()
      .notNull()
      .default([]),
    /** Only these declared fields of the subject; null: all of them. */
    fields: jsonb('fields').$type<string[]>(),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('role_permissions_tenant_idx').on(t.tenantId),
    index('role_permissions_role_id_idx').on(t.roleId),
    tenantReference(
      'role_permissions_role_fk',
      [t.tenantId, t.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
);

/**
 * The roles a member holds in the tenant, until `expiresAt` (null: for
 * good). Goes with the membership.
 */
export const userRoles = tenantTable(
  'user_roles',
  {
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    expiresAt: at('expires_at'),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('user_roles_tenant_idx').on(t.tenantId),
    // A role belongs to one tenant, so (user, role) names the grant.
    primaryKey({ columns: [t.userId, t.roleId] }),
    // The roles list counts each role's live grants: role, the wall's
    // tenant and the end in one index, an index-only scan.
    index('user_roles_role_live_idx').on(t.roleId, t.tenantId, t.expiresAt),
    foreignKey({
      name: 'user_roles_membership_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }).onDelete('cascade'),
    tenantReference(
      'user_roles_role_fk',
      [t.tenantId, t.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
);

/** The roles an API client holds, on top of what every client may do (`clientPermissions`). */
export const apiClientRoles = tenantTable(
  'api_client_roles',
  {
    clientId: uuid('client_id').notNull(),
    roleId: uuid('role_id').notNull(),
    expiresAt: at('expires_at'),
  },
  (t) => [
    // The foreign key to tenants: a tenant's delete and export find its rows.
    index('api_client_roles_tenant_idx').on(t.tenantId),
    primaryKey({ columns: [t.clientId, t.roleId] }),
    index('api_client_roles_role_id_idx').on(t.roleId),
    tenantReference(
      'api_client_roles_client_fk',
      [t.tenantId, t.clientId],
      [apiClients.tenantId, apiClients.id],
    ),
    tenantReference(
      'api_client_roles_role_fk',
      [t.tenantId, t.roleId],
      [roles.tenantId, roles.id],
    ),
  ],
);

/** A role grant still running: no end, or one still to come (an ended one is gone). */
export const liveGrant = (grants: typeof userRoles | typeof apiClientRoles) =>
  or(isNull(grants.expiresAt), gt(grants.expiresAt, new Date()));
