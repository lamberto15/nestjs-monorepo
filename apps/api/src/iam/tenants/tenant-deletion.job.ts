import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import {
  Tenancy,
  TenantRunsFailed,
} from '../../core/tenancy/tenancy.service.js';
import { type Tenant, tenants } from '../../core/tenancy/tenancy.tables.js';
import { SystemContext } from '../access/system-context.js';
import { TENANT_DELETION_JOB } from './tenants.permissions.js';
import { TenantsService } from './tenants.service.js';
import { tenantLifecycle } from './tenants.tables.js';

/** Tenants erased per run at most: a backlog goes over the next nights. */
const BATCH = 50;

/**
 * Erases the tenants whose deletion an operator asked for, once
 * TENANT_DELETION_GRACE_DAYS passed: every night at 04:30 UTC, on one
 * instance, as `system:tenant-deletion`, never in a request, never the
 * operator tenant. Each tenant in turn: claimed under its row's lock
 * (`deletion_started_at`: no cancel from then on); then TenantsService.purge():
 * what lives outside its tables is released (`tenancy.tenant-erasing`, each
 * the listening module's), its row deleted, the database cascading to its
 * rows and memberships, with `tenant.purged` outside any tenant. A step that fails leaves the tenant claimed and
 * there: the next night starts over, and the failures are reported
 * together (TenantRunsFailed). The accounts stay.
 */
@Injectable()
export class TenantDeletionJob {
  private readonly logger = new Logger(TenantDeletionJob.name);

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly system: SystemContext,
    private readonly tenancy: Tenancy,
    private readonly tenants: TenantsService,
  ) {}

  @Cron('30 4 * * *', { name: 'tenant-deletion', timeZone: 'UTC' })
  @OnOneInstance({ key: 'iam:tenant-deletion' })
  @WithoutOverlapping()
  run() {
    return this.eraseDue();
  }

  /** The run itself, past the locks' decorators; `now` for tests. */
  async eraseDue(now = new Date()): Promise<number> {
    const { erased, failures } = await this.system.run(
      TENANT_DELETION_JOB,
      async (system) => {
        let erased = 0;
        const failures: { tenant: Tenant; error: unknown }[] = [];
        for (const tenant of await this.due(now)) {
          try {
            if (
              (await this.claim(tenant.id, now)) &&
              (await this.tenants.purge(system, tenant.id, 'deletion'))
            ) {
              erased++;
            }
          } catch (error) {
            failures.push({ tenant, error });
            this.logger.error(
              `${TENANT_DELETION_JOB.key}: failed for tenant ${tenant.slug}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return { erased, failures };
      },
      { transaction: false, tenantId: null },
    );
    if (erased > 0) {
      this.logger.log(`Tenants erased: ${erased}`);
    }
    if (failures.length > 0) {
      throw new TenantRunsFailed(TENANT_DELETION_JOB.key, failures);
    }
    return erased;
  }

  /** The tenants whose erase is due, oldest schedule first. */
  private due(now: Date) {
    return this.db
      .select({
        id: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        active: tenants.active,
        frozenAt: tenants.frozenAt,
        createdAt: tenants.createdAt,
        updatedAt: tenants.updatedAt,
      })
      .from(tenants)
      .innerJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
      .where(
        and(
          isNotNull(tenantLifecycle.deletionScheduledFor),
          lte(tenantLifecycle.deletionScheduledFor, now),
        ),
      )
      .orderBy(asc(tenantLifecycle.deletionScheduledFor))
      .limit(BATCH);
  }

  /**
   * Claimed under the row's lock (the UPDATE's), conditionally: a deletion
   * cancelled since the list was read is skipped.
   */
  private async claim(tenantId: string, now: Date) {
    const claimed = await this.tenancy.run(null, () =>
      this.db
        .update(tenantLifecycle)
        .set({
          deletionStartedAt: sql`coalesce(${tenantLifecycle.deletionStartedAt}, now())`,
        })
        .where(
          and(
            eq(tenantLifecycle.tenantId, tenantId),
            isNotNull(tenantLifecycle.deletionScheduledFor),
            lte(tenantLifecycle.deletionScheduledFor, now),
          ),
        )
        .returning({ tenantId: tenantLifecycle.tenantId }),
    );
    return claimed.length > 0;
  }
}
