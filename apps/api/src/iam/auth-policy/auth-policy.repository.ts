import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import type { AuthPolicyView } from './auth-policy.schemas.js';
import {
  authPolicies,
  authPolicyPlatform,
  authPolicyUnits,
} from './auth-policy.tables.js';

/** The queries of the sign-in policies: the tenants', their units' and the platform's, in the ambient transaction. */
@Injectable()
export class AuthPolicyRepository {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
  ) {}

  async findTenantPolicy(tenantId: string) {
    const [row] = await this.db
      .select()
      .from(authPolicies)
      .where(eq(authPolicies.tenantId, tenantId));
    return row;
  }

  async saveTenantPolicy(tenantId: string, policy: AuthPolicyView) {
    await this.db
      .insert(authPolicies)
      .values({ tenantId, ...policy })
      .onConflictDoUpdate({
        target: authPolicies.tenantId,
        set: { ...policy, updatedAt: new Date() },
      });
  }

  async findUnitPolicy(unitId: string) {
    const [row] = await this.db
      .select({ requireMfa: authPolicyUnits.requireMfa })
      .from(authPolicyUnits)
      .where(eq(authPolicyUnits.unitId, unitId));
    return row;
  }

  /** Requires two-factor in the unit (a row of the current tenant's). */
  async insertUnitPolicy(unitId: string) {
    await this.db
      .insert(authPolicyUnits)
      .values({ tenantId: this.tenancy.tenantId(), unitId })
      .onConflictDoNothing();
  }

  async deleteUnitPolicy(unitId: string) {
    await this.db
      .delete(authPolicyUnits)
      .where(eq(authPolicyUnits.unitId, unitId));
  }

  /** Whether one of these units requires two-factor. */
  async anyUnitRequiresMfa(unitIds: string[]) {
    const [row] = await this.db
      .select({ unitId: authPolicyUnits.unitId })
      .from(authPolicyUnits)
      .where(
        and(
          inArray(authPolicyUnits.unitId, unitIds),
          eq(authPolicyUnits.requireMfa, true),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async findPlatformPolicy() {
    const [row] = await this.db
      .select({ requireMfa: authPolicyPlatform.requireMfa })
      .from(authPolicyPlatform);
    return row;
  }

  async savePlatformPolicy(requireMfa: boolean, updatedBy: string) {
    await this.db
      .insert(authPolicyPlatform)
      .values({ requireMfa, updatedBy })
      .onConflictDoUpdate({
        target: authPolicyPlatform.id,
        set: { requireMfa, updatedBy, updatedAt: new Date() },
      });
  }
}
