import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { roles, userRoles } from '../access/access.tables.js';
import { memberships, users } from '../auth/auth.tables.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from '../organization/organization.tables.js';
import { invitations } from './invitations.tables.js';

export type Invitation = typeof invitations.$inferSelect;

/**
 * The queries of invitations, and of what accepting one writes (the
 * account, its membership, roles and units), in the invitation's tenant
 * and the ambient transaction.
 */
@Injectable()
export class InvitationsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async insert(values: typeof invitations.$inferInsert) {
    const [invitation] = await this.db
      .insert(invitations)
      .values(values)
      .returning();
    return invitation!;
  }

  async update(id: string, values: Partial<typeof invitations.$inferInsert>) {
    const [invitation] = await this.db
      .update(invitations)
      .set(values)
      .where(eq(invitations.id, id))
      .returning();
    return invitation!;
  }

  /** The invitations not accepted yet, newest first. */
  pending() {
    return this.db
      .select({
        id: invitations.id,
        email: invitations.email,
        name: invitations.name,
        roleIds: invitations.roleIds,
        roleExpiresAt: invitations.roleExpiresAt,
        unitIds: invitations.unitIds,
        invitedBy: invitations.invitedBy,
        tokenHash: invitations.tokenHash,
        sentAt: invitations.sentAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(isNull(invitations.acceptedAt))
      .orderBy(desc(invitations.id));
  }

  /** Deletes a pending invitation; undefined when there is none. */
  async deletePending(id: string) {
    const [gone] = await this.db
      .delete(invitations)
      .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .returning({ email: invitations.email, roleIds: invitations.roleIds });
    return gone;
  }

  /** The pending invitation of this link's hash whose link runs at `now`. */
  async findByLink(tokenHash: string, now: Date) {
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.tokenHash, tokenHash),
          isNull(invitations.acceptedAt),
          gt(invitations.expiresAt, now),
        ),
      );
    return invitation;
  }

  /** A pending invitation, locked until the transaction ends. */
  async lockPending(id: string): Promise<Invitation | undefined> {
    const [invitation] = await this.db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt)))
      .for('update');
    return invitation;
  }

  /** Deletes the pending invitations to `email`, but `keep`. */
  async deletePendingTo(email: string, keep?: string) {
    await this.db
      .delete(invitations)
      .where(
        and(
          eq(invitations.email, email),
          isNull(invitations.acceptedAt),
          keep ? ne(invitations.id, keep) : undefined,
          isNotNull(invitations.email),
        ),
      );
  }

  /** Marks it accepted if this link and address are still its own; undefined otherwise. */
  async take(
    id: string,
    tokenHash: string,
    email: string,
    acceptedBy: string,
  ): Promise<Invitation | undefined> {
    const [taken] = await this.db
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedBy })
      .where(
        and(
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          eq(invitations.tokenHash, tokenHash),
          eq(invitations.email, email),
        ),
      )
      .returning();
    return taken;
  }

  async findAccountByEmail(email: string) {
    const [account] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email));
    return account;
  }

  async insertAccount(values: {
    email: string;
    name: string;
    passwordHash: string;
    emailVerified: boolean;
  }) {
    const [created] = await this.db.insert(users).values(values).returning();
    return created!;
  }

  /** The account's row, locked until the transaction ends. */
  async lockAccount(userId: string) {
    const [locked] = await this.db
      .select({ active: users.active })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return locked;
  }

  /** The membership's row, locked until the transaction ends. */
  async lockMembership(tenantId: string, userId: string) {
    const [membership] = await this.db
      .select({ active: memberships.active })
      .from(memberships)
      .where(
        and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
      )
      .for('update');
    return membership;
  }

  async insertMembership(tenantId: string, userId: string) {
    await this.db.insert(memberships).values({ tenantId, userId });
  }

  async verifyEmail(userId: string) {
    await this.db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.id, userId));
  }

  /** Those of these roles that are the tenant's. */
  async existingRoleIds(ids: string[]) {
    if (!ids.length) return [];
    const rows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.id, ids));
    return rows.map((row) => row.id);
  }

  /** Grants these roles, leaving one already held as it is. */
  async insertGrants(
    userId: string,
    grants: { roleId: string; expiresAt: Date | null }[],
  ) {
    await this.db
      .insert(userRoles)
      .values(grants.map((grant) => ({ userId, ...grant })))
      .onConflictDoNothing();
  }

  /** Those of these units that are the tenant's. */
  async existingUnitIds(ids: string[]) {
    const found = await this.db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(inArray(organizationalUnits.id, ids));
    return found.map((row) => row.id);
  }

  /** The units among these the user holds a membership of with no end. */
  async openUnitIds(userId: string, unitIds: string[]) {
    const open = await this.db
      .select({ unitId: organizationalUnitMemberships.unitId })
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.userId, userId),
          inArray(organizationalUnitMemberships.unitId, unitIds),
          isNull(organizationalUnitMemberships.validTo),
        ),
      );
    return open.map((row) => row.unitId);
  }

  async insertUnitMemberships(
    userId: string,
    unitIds: string[],
    validFrom: Date,
  ) {
    await this.db
      .insert(organizationalUnitMemberships)
      .values(unitIds.map((unitId) => ({ unitId, userId, validFrom })));
  }
}
