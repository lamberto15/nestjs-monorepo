import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../../../core/database/database.js';
import { memberships, users } from '../../auth/auth.tables.js';
import { scimDeprovisionedUsers, scimUsers } from '../sso.tables.js';
import type { FilterAttribute } from './scim-filter.js';

/** The attributes a Users list filters on (`scimFilter()`). */
export const SCIM_USER_FILTER: Record<string, FilterAttribute> = {
  id: { column: scimUsers.userId, uuid: true },
  // The userName the IdP sent, else the account's address.
  userName: {
    column: sql`coalesce(${scimUsers.attributes}->>'userName', ${users.email})`,
    caseInsensitive: true,
  },
  externalId: { column: scimUsers.externalId },
  'emails.value': { column: users.email, caseInsensitive: true },
  active: { column: memberships.active },
};

/** A provisioned user as SCIM answers it: its row, its address, its membership's state. */
const USER = {
  userId: scimUsers.userId,
  externalId: scimUsers.externalId,
  attributes: scimUsers.attributes,
  createdAt: scimUsers.createdAt,
  updatedAt: scimUsers.updatedAt,
  email: users.email,
  active: memberships.active,
};

/**
 * The queries of SCIM Users: the users the tenant's IdP provisioned
 * (`scim_users`), their accounts and memberships, and the accounts
 * deprovisioning deactivated (`scim_deprovisioned_users`), in the
 * request's tenant and the ambient transaction (`@InjectTransaction()`).
 */
@Injectable()
export class ScimUsersRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Those of these users the tenant's IdP provisioned. */
  async provisionedIds(userIds: string[]) {
    const rows = await this.db
      .select({ id: scimUsers.userId })
      .from(scimUsers)
      .where(inArray(scimUsers.userId, userIds));
    return rows.map((row) => row.id);
  }

  /** Those of these users the IdP provisioned that are members. */
  async provisionedMemberIds(userIds: string[]) {
    const rows = await this.db
      .select({ id: scimUsers.userId })
      .from(scimUsers)
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(inArray(scimUsers.userId, userIds));
    return rows.map((row) => row.id);
  }

  list(where: SQL | undefined, page: { limit: number; offset: number }) {
    return this.select(where)
      .orderBy(asc(scimUsers.createdAt), asc(scimUsers.userId))
      .limit(page.limit)
      .offset(page.offset);
  }

  async count(where: SQL | undefined) {
    const [row] = await this.db
      .select({ total: count() })
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(where);
    return row?.total ?? 0;
  }

  async findById(id: string) {
    const [row] = await this.select(eq(scimUsers.userId, id));
    return row;
  }

  async findLink(userId: string) {
    const [row] = await this.db
      .select({ userId: scimUsers.userId })
      .from(scimUsers)
      .where(eq(scimUsers.userId, userId));
    return row;
  }

  async findByExternalId(externalId: string) {
    const [row] = await this.db
      .select({ userId: scimUsers.userId })
      .from(scimUsers)
      .where(eq(scimUsers.externalId, externalId));
    return row;
  }

  async insert(values: {
    userId: string;
    externalId: string | null;
    attributes: Record<string, unknown>;
  }) {
    await this.db.insert(scimUsers).values(values);
  }

  async update(
    userId: string,
    values: {
      externalId: string | null;
      attributes: Record<string, unknown>;
      updatedAt: Date;
    },
  ) {
    await this.db
      .update(scimUsers)
      .set(values)
      .where(eq(scimUsers.userId, userId));
  }

  async delete(userId: string) {
    await this.db.delete(scimUsers).where(eq(scimUsers.userId, userId));
  }

  /** The account with this address, its row locked until the transaction ends. */
  async lockUserByEmail(email: string) {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .for('update');
    return row;
  }

  /** Locks the account's row until the transaction ends. */
  async lockUser(userId: string) {
    await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
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

  async activateUser(userId: string) {
    await this.db
      .update(users)
      .set({ active: true })
      .where(eq(users.id, userId));
  }

  /** Deactivates an active account; undefined when it was not. */
  async deactivateUser(userId: string) {
    const [row] = await this.db
      .update(users)
      .set({ active: false })
      .where(and(eq(users.id, userId), eq(users.active, true)))
      .returning({ id: users.id });
    return row;
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

  async setMembershipActive(tenantId: string, userId: string, active: boolean) {
    await this.db
      .update(memberships)
      .set({ active })
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      );
  }

  /** Whether the account is an active member of any tenant. */
  async hasActiveMembership(userId: string) {
    const [row] = await this.db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), eq(memberships.active, true)))
      .limit(1);
    return !!row;
  }

  async isDeprovisioned(userId: string) {
    const [row] = await this.db
      .select({ userId: scimDeprovisionedUsers.userId })
      .from(scimDeprovisionedUsers)
      .where(eq(scimDeprovisionedUsers.userId, userId));
    return !!row;
  }

  async markDeprovisioned(userId: string) {
    await this.db
      .insert(scimDeprovisionedUsers)
      .values({ userId })
      .onConflictDoNothing();
  }

  /** Removes the account's deprovisioned mark; whether it had one. */
  async unmarkDeprovisioned(userId: string) {
    const [row] = await this.db
      .delete(scimDeprovisionedUsers)
      .where(eq(scimDeprovisionedUsers.userId, userId))
      .returning();
    return !!row;
  }

  private select(where?: SQL) {
    return this.db
      .select(USER)
      .from(scimUsers)
      .innerJoin(users, eq(users.id, scimUsers.userId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.tenantId, scimUsers.tenantId),
          eq(memberships.userId, scimUsers.userId),
        ),
      )
      .where(where);
  }
}
