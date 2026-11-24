import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { memberships, users } from '../auth/auth.tables.js';
import { ssoExemptions, ssoPolicies } from './sso.tables.js';

/**
 * The queries of "SSO required": a tenant's policy and its exemptions, in
 * the ambient transaction (`@InjectTransaction()`). Each says its tenant:
 * a holding's scope may read its subsidiaries' rows too.
 */
@Injectable()
export class SsoPolicyRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async findPolicy(tenantId: string) {
    const [row] = await this.db
      .select()
      .from(ssoPolicies)
      .where(eq(ssoPolicies.tenantId, tenantId));
    return row;
  }

  /** Sets the current tenant's policy. */
  async upsertPolicy(requireSso: boolean) {
    const [row] = await this.db
      .insert(ssoPolicies)
      .values({ requireSso })
      .onConflictDoUpdate({
        target: ssoPolicies.tenantId,
        set: { requireSso, updatedAt: new Date() },
      })
      .returning();
    return row!;
  }

  /** The address of an active member with an active account. */
  async findActiveMember(tenantId: string, userId: string) {
    const [row] = await this.db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, tenantId),
          eq(memberships.userId, userId),
          eq(memberships.active, true),
          eq(users.active, true),
        ),
      );
    return row;
  }

  /** The tenant's exemptions, with their members' address and name, oldest first. */
  exemptions(tenantId: string) {
    return this.db
      .select({
        userId: ssoExemptions.userId,
        email: users.email,
        name: users.name,
        reason: ssoExemptions.reason,
        createdBy: ssoExemptions.createdBy,
        createdAt: ssoExemptions.createdAt,
      })
      .from(ssoExemptions)
      .innerJoin(users, eq(users.id, ssoExemptions.userId))
      .where(eq(ssoExemptions.tenantId, tenantId))
      .orderBy(asc(ssoExemptions.createdAt));
  }

  async findExemption(tenantId: string, userId: string) {
    const [row] = await this.db
      .select({ userId: ssoExemptions.userId })
      .from(ssoExemptions)
      .where(
        and(
          eq(ssoExemptions.tenantId, tenantId),
          eq(ssoExemptions.userId, userId),
        ),
      );
    return row;
  }

  /** Exempts a member of the current tenant, or changes the reason. */
  async upsertExemption(values: {
    userId: string;
    reason: string;
    createdBy: string;
  }) {
    await this.db
      .insert(ssoExemptions)
      .values(values)
      .onConflictDoUpdate({
        target: [ssoExemptions.tenantId, ssoExemptions.userId],
        set: { reason: values.reason },
      });
  }

  async deleteExemption(tenantId: string, userId: string) {
    const [row] = await this.db
      .delete(ssoExemptions)
      .where(
        and(
          eq(ssoExemptions.tenantId, tenantId),
          eq(ssoExemptions.userId, userId),
        ),
      )
      .returning();
    return row;
  }
}
