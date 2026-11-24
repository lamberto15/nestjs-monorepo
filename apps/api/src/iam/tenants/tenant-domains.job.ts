import { Processor } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import type { Job } from 'bullmq';
import {
  type TenantEnvelope,
  TenantWorkerHost,
} from '../../core/tenancy/tenant-job.js';
import { SystemContext } from '../access/system-context.js';
import {
  type DomainCheckJob,
  TENANT_DOMAINS_QUEUE,
  TenantDomainsService,
} from './tenant-domains.service.js';
import { TENANT_DOMAINS_JOB } from './tenants.permissions.js';

/**
 * The DNS checks a tenant asked for, on the workers, in the job's tenant,
 * as `system:tenant-domains`.
 */
@Processor(TENANT_DOMAINS_QUEUE, { concurrency: 2 })
export class TenantDomainsProcessor extends TenantWorkerHost<DomainCheckJob> {
  constructor(
    private readonly system: SystemContext,
    private readonly domains: TenantDomainsService,
  ) {
    super();
  }

  handle(job: Job<DomainCheckJob & TenantEnvelope>) {
    return this.system.run(
      TENANT_DOMAINS_JOB,
      (system) => this.domains.verify(system, job.data.domainId),
      { transaction: false },
    );
  }
}

/**
 * Every night at 02:15 UTC, on one instance: every verified domain's TXT
 * record looked up again, in its tenant. A record gone (the domain changed
 * hands) ends its routing; a lookup that failed changes nothing. One
 * tenant's failure stops no other's.
 */
@Injectable()
export class TenantDomainsCheckJob {
  private readonly logger = new Logger(TenantDomainsCheckJob.name);

  constructor(
    private readonly system: SystemContext,
    private readonly domains: TenantDomainsService,
  ) {}

  @Cron('15 2 * * *', { name: 'tenant-domains', timeZone: 'UTC' })
  @OnOneInstance({ key: 'iam:tenant-domains' })
  @WithoutOverlapping()
  async run() {
    if (!this.domains.enabled) {
      return 0;
    }
    let checked = 0;
    for (const tenantId of await this.domains.routedTenants()) {
      try {
        await this.system.run(
          TENANT_DOMAINS_JOB,
          async (system) => {
            for (const id of await this.domains.verifiedIds()) {
              await this.domains.verify(system, id);
              checked += 1;
            }
          },
          { transaction: false, tenantId },
        );
      } catch (error) {
        this.logger.error(
          `Domain check failed for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return checked;
  }
}
