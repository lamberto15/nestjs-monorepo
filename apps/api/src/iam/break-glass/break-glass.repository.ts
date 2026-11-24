import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { roles, userRoles } from '../access/access.tables.js';
import { liveGrant } from '../access/roles.service.js';
import { memberships } from '../auth/auth.tables.js';
import {
  type BreakGlassGrant,
  breakGlassGrants,
} from './break-glass.tables.js';

/** The queries of break-glass grants, and of a tenant's administrators, in the ambient transaction and scope. */
@Injectable()
export class BreakGlassRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Whether the operator holds a grant to the tenant neither ended nor expired at `now`. */
  async hasRunningGrant(userId: string, targetTenantId: string, now: Date) {
    const [running] = await this.db
      .select({ id: breakGlassGrants.id })
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.userId, userId),
          eq(breakGlassGrants.targetTenantId, targetTenantId),
          isNull(breakGlassGrants.endedAt),
          gt(breakGlassGrants.expiresAt, now),
        ),
      )
      .limit(1);
    return !!running;
  }

  async insert(values: {
    id: string;
    userId: string;
    targetTenantId: string;
    reason: string;
    expiresAt: Date;
  }) {
    const [row] = await this.db
      .insert(breakGlassGrants)
      .values(values)
      .returning();
    return row!;
  }

  /** The operator's latest 50 grants to the tenant, newest first. */
  listOf(userId: string, targetTenantId: string) {
    return this.db
      .select()
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.userId, userId),
          eq(breakGlassGrants.targetTenantId, targetTenantId),
        ),
      )
      .orderBy(desc(breakGlassGrants.createdAt))
      .limit(50);
  }

  /** The operator's grant to the tenant, locked until the transaction ends. */
  async lockGrant(
    id: string,
    userId: string,
    targetTenantId: string,
  ): Promise<BreakGlassGrant | undefined> {
    const [grant] = await this.db
      .select()
      .from(breakGlassGrants)
      .where(
        and(
          eq(breakGlassGrants.id, id),
          eq(breakGlassGrants.userId, userId),
          eq(breakGlassGrants.targetTenantId, targetTenantId),
        ),
      )
      .for('update');
    return grant;
  }

  async end(id: string, endedAt: Date) {
    const [updated] = await this.db
      .update(breakGlassGrants)
      .set({ endedAt })
      .where(eq(breakGlassGrants.id, id))
      .returning();
    return updated!;
  }

  async findOf(
    id: string,
    userId: string,
  ): Promise<BreakGlassGrant | undefined> {
    const [grant] = await this.db
      .select()
      .from(breakGlassGrants)
      .where(
        and(eq(breakGlassGrants.id, id), eq(breakGlassGrants.userId, userId)),
      );
    return grant;
  }

  /** In the tenant's scope: active members holding a system role (the built-in Administrator), live. */
  async administratorIds(tenantId: string) {
    const rows = await this.db
      .selectDistinct({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, userRoles.userId),
          eq(memberships.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(roles.system, true),
          eq(memberships.active, true),
          liveGrant(userRoles),
        ),
      );
    return rows.map((row) => row.userId);
  }
}
