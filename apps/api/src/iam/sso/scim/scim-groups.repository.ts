import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database } from '../../../core/database/database.js';
import { users } from '../../auth/auth.tables.js';
import {
  currentMembership,
  openMembership,
} from '../../organization/memberships.js';
import {
  organizationalUnitClosure,
  organizationalUnitMemberships,
  organizationalUnits,
} from '../../organization/organization.tables.js';
import { UnitTree } from '../../organization/tree.js';
import { scimGroups } from '../sso.tables.js';
import type { FilterAttribute } from './scim-filter.js';

/** The attributes a Groups list filters on (`scimFilter()`). */
export const SCIM_GROUP_FILTER: Record<string, FilterAttribute> = {
  id: { column: scimGroups.unitId, uuid: true },
  displayName: { column: organizationalUnits.name, caseInsensitive: true },
  externalId: { column: scimGroups.externalId },
};

/**
 * The queries of SCIM Groups: the units the tenant's IdP created
 * (`scim_groups`), their unit rows, tree paths and memberships (iam/
 * organization's tables and its UnitTree), in the request's tenant and the
 * ambient transaction (`@InjectTransaction()`).
 */
@Injectable()
export class ScimGroupsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  private readonly tree = new UnitTree();

  /** Those of these units the tenant's IdP created. */
  async managedIds(unitIds: string[]) {
    const rows = await this.db
      .select({ id: scimGroups.unitId })
      .from(scimGroups)
      .where(inArray(scimGroups.unitId, unitIds));
    return rows.map((row) => row.id);
  }

  list(where: SQL | undefined, page: { limit: number; offset: number }) {
    return this.select(where)
      .orderBy(asc(scimGroups.createdAt), asc(scimGroups.unitId))
      .limit(page.limit)
      .offset(page.offset);
  }

  async count(where: SQL | undefined) {
    const [row] = await this.db
      .select({ total: count() })
      .from(scimGroups)
      .innerJoin(
        organizationalUnits,
        eq(organizationalUnits.id, scimGroups.unitId),
      )
      .where(where);
    return row?.total ?? 0;
  }

  async findById(id: string) {
    const [row] = await this.select(eq(scimGroups.unitId, id));
    return row;
  }

  async findByExternalId(externalId: string) {
    const [row] = await this.db
      .select({ unitId: scimGroups.unitId })
      .from(scimGroups)
      .where(eq(scimGroups.externalId, externalId));
    return row;
  }

  /** Locks the group's row until the transaction ends. */
  async lock(id: string) {
    await this.db
      .select({ unitId: scimGroups.unitId })
      .from(scimGroups)
      .where(eq(scimGroups.unitId, id))
      .for('update');
  }

  /** A new top-level team, in the unit tree, as the IdP's group. */
  async insert(values: { name: string; externalId: string | null }) {
    const [unit] = await this.db
      .insert(organizationalUnits)
      .values({ type: 'team', name: values.name, parentId: null })
      .returning();
    await this.tree.add(this.db, unit!.id, null);
    await this.db
      .insert(scimGroups)
      .values({ unitId: unit!.id, externalId: values.externalId });
    return unit!;
  }

  async update(
    id: string,
    values: { name: string; externalId: string | null },
  ) {
    await this.db
      .update(organizationalUnits)
      .set({ name: values.name })
      .where(eq(organizationalUnits.id, id));
    await this.db
      .update(scimGroups)
      .set({ externalId: values.externalId, updatedAt: new Date() })
      .where(eq(scimGroups.unitId, id));
  }

  /** How many units are under this one. */
  async childCount(id: string) {
    const [row] = await this.db
      .select({ children: count() })
      .from(organizationalUnits)
      .where(eq(organizationalUnits.parentId, id));
    return row!.children;
  }

  /** The group, its unit's memberships (not the members) and own paths, then the unit. */
  async delete(id: string) {
    await this.db.delete(scimGroups).where(eq(scimGroups.unitId, id));
    await this.db
      .delete(organizationalUnitMemberships)
      .where(eq(organizationalUnitMemberships.unitId, id));
    await this.db
      .delete(organizationalUnitClosure)
      .where(eq(organizationalUnitClosure.descendantId, id));
    await this.db
      .delete(organizationalUnits)
      .where(eq(organizationalUnits.id, id));
  }

  /** The unit's memberships open at `now`. */
  openMemberships(unitId: string, now: Date) {
    return this.db
      .select({
        id: organizationalUnitMemberships.id,
        userId: organizationalUnitMemberships.userId,
      })
      .from(organizationalUnitMemberships)
      .where(
        and(
          eq(organizationalUnitMemberships.unitId, unitId),
          openMembership(now),
        ),
      );
  }

  async endMemberships(ids: string[], now: Date) {
    await this.db
      .update(organizationalUnitMemberships)
      .set({ validTo: now })
      .where(inArray(organizationalUnitMemberships.id, ids));
  }

  async insertMemberships(unitId: string, userIds: string[], now: Date) {
    await this.db
      .insert(organizationalUnitMemberships)
      .values(userIds.map((userId) => ({ unitId, userId, validFrom: now })));
  }

  /** The current members of these units, with their address, by address. */
  membersOf(unitIds: string[]) {
    const member = organizationalUnitMemberships;
    return this.db
      .select({
        unitId: member.unitId,
        userId: member.userId,
        email: users.email,
      })
      .from(member)
      .innerJoin(users, eq(users.id, member.userId))
      .where(and(inArray(member.unitId, unitIds), currentMembership()))
      .orderBy(asc(users.email));
  }

  private select(where?: SQL) {
    return this.db
      .select({
        unitId: scimGroups.unitId,
        externalId: scimGroups.externalId,
        name: organizationalUnits.name,
        createdAt: scimGroups.createdAt,
        updatedAt: scimGroups.updatedAt,
      })
      .from(scimGroups)
      .innerJoin(
        organizationalUnits,
        eq(organizationalUnits.id, scimGroups.unitId),
      )
      .where(where);
  }
}
