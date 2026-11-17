import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, eq, exists, lt, not, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { TenantRunsFailed } from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { SystemContext } from '../access/system-context.js';
import { memberships, users } from '../auth/auth.tables.js';
import { SIGN_UP_SWEEP_JOB } from './tenants.permissions.js';
import { TenantsService } from './tenants.service.js';
import { tenantLifecycle } from './tenants.tables.js';

/** How long a tenant made by a sign-up nobody verified is kept. */
export const UNVERIFIED_SIGN_UP_GRACE_DAYS = 7;
/** Tenants deleted per run at most. */
const BATCH = 500;

/**
 * Deletes the tenants self sign-ups made (TENANT_SIGN_UP) whose members
 * never proved their address, UNVERIFIED_SIGN_UP_GRACE_DAYS after the
 * sign-up: a sign-up makes its tenant before the address is proved, so
 * sign-ups nobody finishes (bots past the limits, typos) would pile up.
 * Every night at 04:15 UTC, on one instance, as
 * `system:sign-up-tenant-sweep`. Each tenant in its own transaction,
 * checked again under the lock (an address proved meanwhile keeps its
 * tenant); its row goes (TenantsService.purge(): its members never signed
 * in, so it holds nothing outside its tables). The accounts stay, in no
 * tenant. Never an operator tenant.
 */
@Injectable()
export class SignUpSweepJob {
  private readonly logger = new Logger(SignUpSweepJob.name);

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly system: SystemContext,
    private readonly tenants: TenantsService,
  ) {}

  @Cron('15 4 * * *', { name: 'sign-up-tenant-sweep', timeZone: 'UTC' })
  @OnOneInstance({ key: 'iam:sign-up-tenant-sweep' })
  @WithoutOverlapping()
  run() {
    return this.sweep();
  }

  /** The run itself, past the locks' decorators; `now` for tests. */
  async sweep(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - UNVERIFIED_SIGN_UP_GRACE_DAYS * 86_400_000,
    );
    const { deleted, failures } = await this.system.run(
      SIGN_UP_SWEEP_JOB,
      async (system) => {
        let deleted = 0;
        const failures: { tenant: Tenant; error: unknown }[] = [];
        for (const tenant of await this.candidates(cutoff)) {
          try {
            const purged = await this.tenants.purge(
              system,
              tenant.id,
              'sign-up-unverified',
              { days: UNVERIFIED_SIGN_UP_GRACE_DAYS },
              async () => !(await this.anyVerified(tenant.id)),
            );
            if (purged) deleted++;
          } catch (error) {
            failures.push({ tenant, error });
            this.logger.error(
              `${SIGN_UP_SWEEP_JOB.key}: failed for tenant ${tenant.slug}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { deleted, failures };
      },
      { transaction: false, tenantId: null },
    );
    if (deleted > 0) {
      this.logger.log(`Unverified sign-ups' tenants deleted: ${deleted}`);
    }
    if (failures.length > 0) {
      throw new TenantRunsFailed(SIGN_UP_SWEEP_JOB.key, failures);
    }
    return deleted;
  }

  private verifiedMember(tenantId: typeof tenants.id | string) {
    return this.db
      .select({ one: sql`1` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.tenantId, tenantId), eq(users.emailVerified, true)),
      );
  }

  /** The sign-ups' tenants past the grace whose members all are unverified. */
  private candidates(cutoff: Date) {
    return this.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        active: tenants.active,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
      })
      .from(tenants)
      .innerJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
      .where(
        and(
          eq(tenantLifecycle.createdBySignUp, true),
          lt(tenants.createdAt, cutoff),
          not(exists(this.verifiedMember(tenants.id))),
        ),
      )
      .orderBy(tenants.createdAt)
      .limit(BATCH);
  }

  /** In the purge's transaction: the members locked, any of them verified since? */
  private async anyVerified(tenantId: string) {
    const members = await this.db
      .select({ verified: users.emailVerified })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .for('update', { of: users });
    return members.some(({ verified }) => verified);
  }
}
