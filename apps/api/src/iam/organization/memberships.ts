import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import {
  organizationalUnitClosure,
  organizationalUnitMemberships,
  type UnitRole,
} from './organization.tables.js';

/**
 * Which of a user's units: `below` adds every unit under them, `above`
 * every unit over them (not both), `role` keeps those they hold that role in.
 */
export interface UnitsOfOptions {
  below?: boolean;
  above?: boolean;
  role?: UnitRole;
}

/** Builds subqueries with no connection: they run inside the caller's query. */
const subquery = new QueryBuilder();

/** A membership current at `at`: started (`validFrom`), and not ended (`validTo`, exclusive). */
export const currentMembership = (at = new Date()) =>
  and(
    lte(organizationalUnitMemberships.validFrom, at),
    or(
      isNull(organizationalUnitMemberships.validTo),
      gt(organizationalUnitMemberships.validTo, at),
    ),
  );

/** A membership that hasn't ended: current, or dated ahead. */
export const openMembership = (at = new Date()) =>
  or(
    isNull(organizationalUnitMemberships.validTo),
    gt(organizationalUnitMemberships.validTo, at),
  );

/**
 * The ids of the units `userId` is a current member of at `at`, as a
 * subquery: `inArray(column, unitIdsOf(id))`. Membership of a unit never
 * implies its parent. Read in the caller's transaction, in its tenant.
 */
export function unitIdsOf(
  userId: string,
  options: UnitsOfOptions = {},
  at = new Date(),
) {
  const member = organizationalUnitMemberships;
  const current = and(
    eq(member.userId, userId),
    currentMembership(at),
    options.role ? eq(member.role, options.role) : undefined,
  );
  const tree = organizationalUnitClosure;
  if (options.above) {
    // Their units and each one over them: the closure holds a unit as its own ancestor.
    return subquery
      .select({ id: tree.ancestorId })
      .from(tree)
      .innerJoin(member, eq(member.unitId, tree.descendantId))
      .where(current);
  }
  if (!options.below) {
    return subquery.select({ id: member.unitId }).from(member).where(current);
  }
  return subquery
    .select({ id: tree.descendantId })
    .from(tree)
    .innerJoin(member, eq(member.unitId, tree.ancestorId))
    .where(current);
}
