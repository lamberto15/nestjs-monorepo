import { DiscoveryService } from '@nestjs/core';
import type { SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { AccessContext } from './permissions.js';

/**
 * What access needs to know of organizational units, without importing
 * the module that keeps them (iam/organization, which imports access):
 * that module marks one provider `@UnitDirectory()`. Without one, nobody
 * is in a unit: the unit conditions match nothing, users have no
 * `unitIds`, and the users list's `unitId` filter matches no one.
 */
export interface UnitDirectory {
  /**
   * The user's units as the unit conditions read them, in the current
   * tenant, and when one of their memberships starts or ends next (epoch
   * ms): a cached ability is rebuilt then.
   */
  context(
    userId: string,
    now: Date,
  ): Promise<{ context: AccessContext; nextChange?: number }>;
  /** The units each of these users is a current member of, directly. */
  unitIdsOf(userIds: readonly string[]): Promise<Map<string, string[]>>;
  /** A condition on `userId`: its user is a current member of one of these units (directly). */
  membersOf(userId: AnyPgColumn, unitIds: readonly string[]): SQL;
}

/** Marks the provider that implements UnitDirectory (at most one). */
export const UnitDirectory = DiscoveryService.createDecorator<void>();
