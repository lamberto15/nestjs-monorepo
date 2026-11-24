import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  getColumns,
  gt,
  inArray,
  lt,
  or,
  type SQL,
} from 'drizzle-orm';
import { type AnyPgColumn, QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { memberships, users } from '../auth/auth.tables.js';
import {
  currentMembership,
  openMembership,
  unitIdsOf,
  type UnitsOfOptions,
} from './memberships.js';
import {
  organizationalUnitClosure,
  organizationalUnitMemberships,
  organizationalUnits,
  type UnitRole,
  type UnitType,
} from './organization.tables.js';
import { UnitTree } from './tree.js';

/** Builds subqueries with no connection: they run inside the caller's query. */
const subquery = new QueryBuilder();

type Membership = typeof organizationalUnitMemberships.$inferSelect;

/**
 * The queries of the units, their tree (UnitTree, on this transaction) and
 * their memberships, in the request's tenant and the ambient transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class OrganizationRepository {
  private readonly tree = new UnitTree();

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
  ) {}

  units() {
    return this.db
      .select()
      .from(organizationalUnits)
      .orderBy(asc(organizationalUnits.name));
  }

  /** Each unit's count of ancestors, itself included. */
  ancestorCounts() {
    return this.db
      .select({ id: organizationalUnitClosure.descendantId, depth: count() })
      .from(organizationalUnitClosure)
      .groupBy(organizationalUnitClosure.descendantId);
  }

  /** Each unit's count of memberships current at `at`. */
  memberCounts(at: Date) {
    return this.db
      .select({ id: organizationalUnitMemberships.unitId, members: count() })
      .from(organizationalUnitMemberships)
      .where(currentMembership(at))
      .groupBy(organizationalUnitMemberships.unitId);
  }

  async findById(id: string) {
    const [unit] = await this.db
      .select()
      .from(organizationalUnits)
      .where(eq(organizationalUnits.id, id));
    return unit;
  }

  async insert(values: {
    type: UnitType;
    name: string;
    parentId: string | null;
  }) {
    const [row] = await this.db
      .insert(organizationalUnits)
      .values(values)
      .returning();
    return row!;
  }

  async update(
    id: string,
    values: { type?: UnitType; name?: string; parentId?: string | null },
  ) {
    const [row] = await this.db
      .update(organizationalUnits)
      .set(values)
      .where(eq(organizationalUnits.id, id))
      .returning();
    return row!;
  }

  /** Records a new unit in the tree, under `parentId` (null: a root). */
  addToTree(id: string, parentId: string | null) {
    return this.tree.add(this.db, id, parentId);
  }

  /** Moves a subtree; a TreeCycleError for a move under itself. */
  moveInTree(id: string, parentId: string | null) {
    return this.tree.move(this.db, id, parentId);
  }

  /** Users current members of the units above `id`, or (`moving`) below it or above `parentId`. */
  async affectedByUnitChange(
    id: string,
    moving: boolean,
    parentId: string | null | undefined,
    limit: number,
  ) {
    const member = organizationalUnitMemberships;
    const rows = await this.db
      .selectDistinct({ id: member.userId })
      .from(member)
      .where(
        and(
          currentMembership(),
          or(
            inArray(member.unitId, this.tree.ancestors(id)),
            moving
              ? inArray(member.unitId, this.tree.descendants(id))
              : undefined,
            parentId
              ? inArray(member.unitId, this.tree.ancestors(parentId))
              : undefined,
          ),
        ),
      )
      .orderBy(member.userId)
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async countChildren(id: string) {
    const [row] = await this.db
      .select({ count: count() })
      .from(organizationalUnits)
      .where(eq(organizationalUnits.parentId, id));
    return row!.count;
  }

  async countOpenMemberships(id: string) {
    const [row] = await this.db
      .select({ count: count() })
      .from(organizationalUnitMemberships)
      .where(
        and(eq(organizationalUnitMemberships.unitId, id), openMembership()),
      );
    return row!.count;
  }

  /** Deletes the unit's (ended) memberships and its own paths. */
  async deleteMembershipsAndPaths(id: string) {
    await this.db
      .delete(organizationalUnitMemberships)
      .where(eq(organizationalUnitMemberships.unitId, id));
    await this.db
      .delete(organizationalUnitClosure)
      .where(eq(organizationalUnitClosure.descendantId, id));
  }

  async delete(id: string) {
    await this.db
      .delete(organizationalUnits)
      .where(eq(organizationalUnits.id, id));
  }

  /** The user's units at `at` (UnitsOfOptions). */
  async unitIdsOf(userId: string, options: UnitsOfOptions, at = new Date()) {
    const rows = await this.db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(inArray(organizationalUnits.id, unitIdsOf(userId, options, at)));
    return rows.map((row) => row.id);
  }

  /** The user's memberships starting or ending after `now`. */
  periodsAfter(userId: string, now: Date) {
    const member = organizationalUnitMemberships;
    return this.db
      .select({ validFrom: member.validFrom, validTo: member.validTo })
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          or(gt(member.validFrom, now), gt(member.validTo, now)),
        ),
      );
  }

  /** The current memberships of these users. */
  currentMembershipsOf(userIds: string[]) {
    return this.db
      .select({
        userId: organizationalUnitMemberships.userId,
        unitId: organizationalUnitMemberships.unitId,
      })
      .from(organizationalUnitMemberships)
      .where(
        and(
          inArray(organizationalUnitMemberships.userId, userIds),
          currentMembership(),
        ),
      );
  }

  /** `userId` is a current member of one of these units, as a condition of the caller's query. */
  membersOf(userId: AnyPgColumn, unitIds: readonly string[]): SQL {
    const member = organizationalUnitMemberships;
    return inArray(
      userId,
      subquery
        .select({ id: member.userId })
        .from(member)
        .where(and(inArray(member.unitId, [...unitIds]), currentMembership())),
    );
  }

  /** The ancestors of these units, each with its distance. */
  ancestorsOf(unitIds: string[]) {
    const tree = organizationalUnitClosure;
    return this.db
      .selectDistinct({ id: tree.ancestorId, depth: tree.depth })
      .from(tree)
      .where(inArray(tree.descendantId, unitIds));
  }

  async currentMemberIds(unitIds: string[]) {
    const member = organizationalUnitMemberships;
    const rows = await this.db
      .selectDistinct({ id: member.userId })
      .from(member)
      .where(and(inArray(member.unitId, unitIds), currentMembership()));
    return rows.map((row) => row.id);
  }

  /** A unit's memberships, latest first, with each member's name and email. */
  membershipsOf(unitId: string) {
    return this.db
      .select({
        ...getColumns(organizationalUnitMemberships),
        name: users.name,
        email: users.email,
      })
      .from(organizationalUnitMemberships)
      .innerJoin(users, eq(users.id, organizationalUnitMemberships.userId))
      .where(eq(organizationalUnitMemberships.unitId, unitId))
      .orderBy(
        desc(organizationalUnitMemberships.validFrom),
        asc(organizationalUnitMemberships.userId),
      );
  }

  /** Whether the user is a member of the tenant (`memberships` is global). */
  async isTenantMember(userId: string) {
    const [member] = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, this.tenancy.tenantId()),
          eq(memberships.userId, userId),
        ),
      );
    return !!member;
  }

  /** The user's latest membership of the unit that hasn't ended. */
  async openMembershipOf(
    unitId: string,
    userId: string,
  ): Promise<Membership | undefined> {
    const [row] = await this.db
      .select()
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          eq(organizationalUnitMemberships.userId, userId),
          openMembership(),
        ),
      )
      .orderBy(desc(organizationalUnitMemberships.validFrom))
      .limit(1);
    return row;
  }

  async insertMembership(values: {
    unitId: string;
    userId: string;
    role: UnitRole;
    validFrom: Date;
    validTo: Date | null;
  }) {
    const [row] = await this.db
      .insert(organizationalUnitMemberships)
      .values(values)
      .returning();
    return row!;
  }

  async setMembershipRole(id: string, role: UnitRole) {
    const [row] = await this.db
      .update(organizationalUnitMemberships)
      .set({ role })
      .where(eq(organizationalUnitMemberships.id, id))
      .returning();
    return row!;
  }

  /** Ends a membership at `at` if it started before; returns whether it did. */
  async endMembership(id: string, at: Date) {
    const ended = await this.db
      .update(organizationalUnitMemberships)
      .set({ validTo: at })
      .where(
        and(
          eq(organizationalUnitMemberships.id, id),
          lt(organizationalUnitMemberships.validFrom, at),
        ),
      )
      .returning({ id: organizationalUnitMemberships.id });
    return ended.length > 0;
  }

  async deleteMembership(id: string) {
    await this.db
      .delete(organizationalUnitMemberships)
      .where(eq(organizationalUnitMemberships.id, id));
  }

  people(ids: string[]) {
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
  }
}
