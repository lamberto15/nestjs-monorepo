import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, inArray, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import {
  UnitDirectory,
  type UnitDirectory as Directory,
} from '../access/unit-directory.js';
import type { AccessContext } from '../access/permissions.js';
import {
  currentMembership,
  unitIdsOf,
  type UnitsOfOptions,
} from './memberships.js';
import {
  organizationalUnitMemberships,
  organizationalUnits,
} from './organization.tables.js';

const subquery = new QueryBuilder();

/**
 * What access reads of the units (iam/access/unit-directory.ts): a user's
 * units as the unit conditions read them, the units of the users it
 * lists, and the users list's `unitId` filter. In the current
 * transaction, in its tenant.
 */
@UnitDirectory()
@Injectable()
export class OrganizationUnitDirectory implements Directory {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async context(userId: string, now: Date) {
    const member = organizationalUnitMemberships;
    // One after the other: in a transaction, one connection.
    const context = await this.unitContext(userId, now);
    const periods = await this.db
      .select({ validFrom: member.validFrom, validTo: member.validTo })
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          or(gt(member.validFrom, now), gt(member.validTo, now)),
        ),
      );
    const changes = periods
      .flatMap((period) => [period.validFrom, period.validTo])
      .map((date) => date?.getTime())
      .filter((time): time is number => time !== undefined && time > +now);
    return {
      context,
      nextChange: changes.length ? Math.min(...changes) : undefined,
    };
  }

  /** A user's units, those and below, and those they lead and below, at `now`. */
  async unitContext(userId: string, now = new Date()): Promise<AccessContext> {
    const ids = async (options: UnitsOfOptions) =>
      (
        await this.db
          .select({ id: organizationalUnits.id })
          .from(organizationalUnits)
          .where(
            inArray(organizationalUnits.id, unitIdsOf(userId, options, now)),
          )
      ).map((row) => row.id);
    const directUnitIds = await ids({});
    const unitIdsAndBelow = await ids({ below: true });
    const ledUnitIdsAndBelow = await ids({ below: true, role: 'lead' });
    return { directUnitIds, unitIdsAndBelow, ledUnitIdsAndBelow };
  }

  async unitIdsOf(userIds: readonly string[]) {
    const byUser = new Map<string, string[]>();
    if (!userIds.length) return byUser;
    const rows = await this.db
      .select({
        userId: organizationalUnitMemberships.userId,
        unitId: organizationalUnitMemberships.unitId,
      })
      .from(organizationalUnitMemberships)
      .where(
        and(
          inArray(organizationalUnitMemberships.userId, [...userIds]),
          currentMembership(),
        ),
      );
    for (const { userId, unitId } of rows) {
      byUser.set(userId, [...(byUser.get(userId) ?? []), unitId]);
    }
    return byUser;
  }

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
}
