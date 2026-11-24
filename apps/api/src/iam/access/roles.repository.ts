import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { memberships, users } from '../auth/auth.tables.js';
import {
  apiClientRoles,
  liveGrant,
  rolePermissions,
  roles,
  userRoles,
} from './access.tables.js';
import type { PermissionInput } from './permissions.js';

export type Role = typeof roles.$inferSelect;

/**
 * The queries of the tenant's roles, their permissions and their grants to
 * users and API clients, in the request's tenant and the ambient
 * transaction.
 */
@Injectable()
export class RolesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  list() {
    return this.db.select().from(roles).orderBy(asc(roles.name));
  }

  async findById(id: string): Promise<Role | undefined> {
    const [role] = await this.db.select().from(roles).where(eq(roles.id, id));
    return role;
  }

  /** Those of these roles that are the tenant's. */
  async existingIds(ids: string[]) {
    const rows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.id, ids));
    return rows.map((row) => row.id);
  }

  async insert(values: typeof roles.$inferInsert) {
    const [role] = await this.db
      .insert(roles)
      .values(values)
      .returning({ id: roles.id });
    return role!.id;
  }

  async update(id: string, values: { name: string; description: string }) {
    await this.db.update(roles).set(values).where(eq(roles.id, id));
  }

  async delete(id: string) {
    await this.db.delete(roles).where(eq(roles.id, id));
  }

  /** Locks the role's row until the transaction ends. */
  async lock(id: string) {
    await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.id, id))
      .for('update');
  }

  /** Locks the role of this key (the built-in Administrator's row is the lock of its holders). */
  async lockByKey(key: string) {
    await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, key))
      .for('update');
  }

  /** The active members holding a system role by a grant still running, counted. */
  async countActiveAdministrators() {
    const [row] = await this.db
      .select({ admins: count() })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, userRoles.tenantId),
          eq(memberships.userId, userRoles.userId),
        ),
      )
      .where(
        and(
          eq(roles.system, true),
          eq(users.active, true),
          eq(memberships.active, true),
          liveGrant(userRoles),
        ),
      );
    return row?.admins ?? 0;
  }

  /** The permissions of these roles. */
  permissionsOf(roleIds: string[]): Promise<PermissionInput[]> {
    return this.db
      .select({
        subject: rolePermissions.subject,
        action: rolePermissions.action,
        conditions: rolePermissions.conditions,
        fields: rolePermissions.fields,
      })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));
  }

  /** The permission rows of these roles. */
  permissionRowsOf(roleIds: string[]) {
    return this.db
      .select()
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));
  }

  async insertPermissions(roleId: string, permissions: PermissionInput[]) {
    await this.db.insert(rolePermissions).values(
      permissions.map(({ subject, action, conditions, fields }) => ({
        roleId,
        subject,
        action,
        conditions,
        fields: fields ?? null,
      })),
    );
  }

  async deletePermissions(roleId: string) {
    await this.db
      .delete(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
  }

  /** How many hold each of these roles by a grant still running. */
  memberCounts(roleIds: string[]) {
    return this.db
      .select({ roleId: userRoles.roleId, members: count() })
      .from(userRoles)
      .where(and(inArray(userRoles.roleId, roleIds), liveGrant(userRoles)))
      .groupBy(userRoles.roleId);
  }

  /** Every role the user was granted, ended grants too. */
  async roleIdsOfUser(userId: string) {
    const rows = await this.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    return rows.map((row) => row.roleId);
  }

  /** The permissions a user or client holds by grants running at `now`, each with its role and end. */
  grantedPermissions(kind: 'user' | 'client', id: string, now: Date) {
    const grants = kind === 'user' ? userRoles : apiClientRoles;
    const holder = kind === 'user' ? userRoles.userId : apiClientRoles.clientId;
    return this.db
      .select({
        subject: rolePermissions.subject,
        action: rolePermissions.action,
        conditions: rolePermissions.conditions,
        fields: rolePermissions.fields,
        roleId: rolePermissions.roleId,
        expiresAt: grants.expiresAt,
      })
      .from(rolePermissions)
      .innerJoin(grants, eq(grants.roleId, rolePermissions.roleId))
      .where(
        and(
          eq(holder, id),
          or(isNull(grants.expiresAt), gt(grants.expiresAt, now)),
        ),
      );
  }

  /** The user's roles, by name, with each grant's end. */
  rolesOfUser(userId: string) {
    return this.db
      .select({
        id: roles.id,
        name: roles.name,
        expiresAt: userRoles.expiresAt,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId))
      .orderBy(asc(roles.name));
  }
}
