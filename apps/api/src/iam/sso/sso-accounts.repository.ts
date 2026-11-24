import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, lte } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { userRoles } from '../access/access.tables.js';
import { memberships, refreshTokens, users } from '../auth/auth.tables.js';
import { tokenSignInMethod } from '../auth/token-session.js';
import { ssoIdentities, ssoRoleGrants } from './sso.tables.js';

/**
 * The queries of an SSO sign-in's account: its identities, accounts,
 * memberships, role grants and refresh tokens, in the connection's tenant
 * and the ambient transaction (`@InjectTransaction()`).
 */
@Injectable()
export class SsoAccountsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** The account of a known identity, and whether it is active. */
  async findIdentity(connectionId: string, subject: string) {
    const [row] = await this.db
      .select({ userId: ssoIdentities.userId, active: users.active })
      .from(ssoIdentities)
      .innerJoin(users, eq(users.id, ssoIdentities.userId))
      .where(
        and(
          eq(ssoIdentities.connectionId, connectionId),
          eq(ssoIdentities.subject, subject),
        ),
      );
    return row;
  }

  async insertIdentity(values: {
    connectionId: string;
    subject: string;
    userId: string;
  }) {
    await this.db.insert(ssoIdentities).values(values);
  }

  /** Who signed in through the connection: its identities' accounts. */
  async usersOf(connectionId: string) {
    const rows = await this.db
      .selectDistinct({ userId: ssoIdentities.userId })
      .from(ssoIdentities)
      .where(eq(ssoIdentities.connectionId, connectionId));
    return rows.map((row) => row.userId);
  }

  async findUserByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return row;
  }

  /** The account, its row locked until the transaction ends. */
  async lockUser(id: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .for('update');
    return row;
  }

  async insertUser(values: {
    email: string;
    name: string;
    passwordHash: null;
    emailVerified: boolean;
  }) {
    const [row] = await this.db.insert(users).values(values).returning();
    return row!;
  }

  /** The membership's state, its row locked until the transaction ends. */
  async lockMembership(tenantId: string, userId: string) {
    const [row] = await this.db
      .select({ active: memberships.active })
      .from(memberships)
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      )
      .for('update');
    return row;
  }

  async insertMembership(tenantId: string, userId: string) {
    await this.db.insert(memberships).values({ tenantId, userId });
  }

  async deleteEndedRoles(tenantId: string, userId: string, now: Date) {
    await this.db
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.tenantId, tenantId),
          eq(userRoles.userId, userId),
          lte(userRoles.expiresAt, now),
        ),
      );
  }

  async roleIdsOf(tenantId: string, userId: string) {
    const rows = await this.db
      .select({ roleId: userRoles.roleId })
      .from(userRoles)
      .where(
        and(eq(userRoles.tenantId, tenantId), eq(userRoles.userId, userId)),
      );
    return rows.map((row) => row.roleId);
  }

  async grantRoles(userId: string, roleIds: string[]) {
    await this.db
      .insert(userRoles)
      .values(roleIds.map((roleId) => ({ userId, roleId })))
      .onConflictDoNothing();
  }

  async revokeRoles(userId: string, roleIds: string[]) {
    await this.db
      .delete(userRoles)
      .where(
        and(eq(userRoles.userId, userId), inArray(userRoles.roleId, roleIds)),
      );
  }

  /** Marks these grants as the connection's own (`sso_role_grants`). */
  async markGrants(connectionId: string, userId: string, roleIds: string[]) {
    await this.db
      .insert(ssoRoleGrants)
      .values(roleIds.map((roleId) => ({ userId, roleId, connectionId })))
      .onConflictDoNothing();
  }

  /** The roles the connection's mappings granted the user. */
  async markedRoleIds(connectionId: string, userId: string) {
    const rows = await this.db
      .select({ roleId: ssoRoleGrants.roleId })
      .from(ssoRoleGrants)
      .where(
        and(
          eq(ssoRoleGrants.userId, userId),
          eq(ssoRoleGrants.connectionId, connectionId),
        ),
      );
    return rows.map((row) => row.roleId);
  }

  /** The live refresh families these users signed in to by `method`. */
  liveFamilies(userIds: string[], method: string) {
    return this.db
      .selectDistinct({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(
        and(
          inArray(refreshTokens.userId, userIds),
          eq(refreshTokens.revoked, false),
          eq(tokenSignInMethod, method),
        ),
      );
  }
}
