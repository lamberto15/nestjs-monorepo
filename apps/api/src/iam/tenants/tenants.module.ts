import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { InvitationsModule } from '../invitations/invitations.module.js';
import { SignUpController } from './sign-up.controller.js';
import { SignUpService } from './sign-up.service.js';
import { SignUpSweepJob } from './sign-up-sweep.job.js';
import { TenantDeletionJob } from './tenant-deletion.job.js';
import { TenantDomainsController } from './tenant-domains.controller.js';
import {
  TenantDomainsCheckJob,
  TenantDomainsProcessor,
} from './tenant-domains.job.js';
import {
  systemTxtResolver,
  TENANT_DOMAINS_QUEUE,
  TenantDomainsService,
  TXT_RESOLVER,
} from './tenant-domains.service.js';
import { TenantSwitchController } from './tenant-switch.controller.js';
import { TenantSwitchService } from './tenant-switch.service.js';
import { tenantsConfig } from './tenants.config.js';
import { TenantsController } from './tenants.controller.js';
import { TENANT_PERMISSIONS } from './tenants.permissions.js';
import { TenantsPolicy } from './tenants.policy.js';
import { TenantsService } from './tenants.service.js';

/**
 * Tenants (README.md): self sign-up, a user's tenants and the switch, the
 * operators' administration (create, change, deactivate, delete after a
 * grace period, the nightly erase), the unverified sign-ups' sweep, and a
 * tenant's own domains (the `@HostTenantResolver()` SessionAuth asks).
 * What other modules react to: tenants.events.ts. Imports InvitationsModule
 * (an operator's tenant invites its first administrator). Needs AuthModule,
 * AccessModule, AuditModule, MailModule's queue, SharedOutboxModule, QueuesModule, RedisModule,
 * EventEmitterModule.forRoot().
 */
@Module({
  imports: [
    AccessModule.forFeature(TENANT_PERMISSIONS),
    AuditModule,
    InvitationsModule,
    DiscoveryModule,
    ConfigModule.forFeature(tenantsConfig),
    ConfigModule.forFeature(httpConfig),
    BullModule.registerQueue({ name: TENANT_DOMAINS_QUEUE }),
  ],
  controllers: [
    TenantsController,
    TenantSwitchController,
    SignUpController,
    TenantDomainsController,
  ],
  providers: [
    TenantsService,
    TenantsPolicy,
    TenantSwitchService,
    SignUpService,
    TenantDeletionJob,
    SignUpSweepJob,
    TenantDomainsService,
    TenantDomainsProcessor,
    TenantDomainsCheckJob,
    { provide: TXT_RESOLVER, useValue: systemTxtResolver },
  ],
  // The operator CLI makes tenants (src/cli).
  exports: [TenantsService],
})
export class TenantsModule {}
