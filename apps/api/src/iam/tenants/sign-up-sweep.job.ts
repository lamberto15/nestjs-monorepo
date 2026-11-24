import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { TenantRunsFailed } from '../../core/tenancy/tenancy.service.js';
import type { Tenant } from '../../core/tenancy/tenancy.tables.js';
import { SystemContext } from '../access/system-context.js';
import { SIGN_UP_SWEEP_JOB } from './tenants.permissions.js';
import { TenantsService } from './tenants.service.js';
import { TenantsRepository } from './tenants.repository.js';

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
    private readonly repository: TenantsRepository,
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
        for (const tenant of await this.repository.unverifiedSignUps(
          cutoff,
          BATCH,
        )) {
          try {
            const purged = await this.tenants.purge(
              system,
              tenant.id,
              'sign-up-unverified',
              { days: UNVERIFIED_SIGN_UP_GRACE_DAYS },
              async () => !(await this.repository.anyMemberVerified(tenant.id)),
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
}
