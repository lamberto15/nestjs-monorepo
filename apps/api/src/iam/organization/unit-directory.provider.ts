import { Injectable } from '@nestjs/common';
import {
  UnitDirectory,
  type UnitDirectory as Directory,
} from '../access/unit-directory.js';
import type { AccessContext } from '../access/permissions.js';
import type { UnitsOfOptions } from './memberships.js';
import { OrganizationRepository } from './organization.repository.js';

/**
 * What access reads of the units (iam/access/unit-directory.ts): a user's
 * units as the unit conditions read them, the units of the users it
 * lists, and the users list's `unitId` filter. In the current
 * transaction, in its tenant.
 */
@UnitDirectory()
@Injectable()
export class OrganizationUnitDirectory implements Directory {
  constructor(private readonly repository: OrganizationRepository) {}

  async context(userId: string, now: Date) {
    // One after the other: in a transaction, one connection.
    const context = await this.unitContext(userId, now);
    const periods = await this.repository.periodsAfter(userId, now);
    const changes = periods
      .flatMap((period) => [period.validFrom, period.validTo])
      .map((date) => date?.getTime())
      .filter((time): time is number => time !== undefined && time > +now);
    return {
      context,
      nextChange: changes.length ? Math.min(...changes) : undefined,
    };
  }

  /** A user's units, those and below, those and above, and those they lead and below, at `now`. */
  async unitContext(userId: string, now = new Date()): Promise<AccessContext> {
    const ids = (options: UnitsOfOptions) =>
      this.repository.unitIdsOf(userId, options, now);
    const directUnitIds = await ids({});
    const unitIdsAndBelow = await ids({ below: true });
    const unitIdsAndAbove = await ids({ above: true });
    const ledUnitIdsAndBelow = await ids({ below: true, role: 'lead' });
    return {
      directUnitIds,
      unitIdsAndBelow,
      unitIdsAndAbove,
      ledUnitIdsAndBelow,
    };
  }

  async unitIdsOf(userIds: readonly string[]) {
    const byUser = new Map<string, string[]>();
    if (!userIds.length) return byUser;
    const rows = await this.repository.currentMembershipsOf([...userIds]);
    for (const { userId, unitId } of rows) {
      byUser.set(userId, [...(byUser.get(userId) ?? []), unitId]);
    }
    return byUser;
  }

  membersOf: Directory['membersOf'] = (userId, unitIds) =>
    this.repository.membersOf(userId, unitIds);
}
