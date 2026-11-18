import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { type Quota, QuotaRegistration } from './quota.js';
import {
  OperatorQuotasController,
  QuotasController,
} from './quotas.controller.js';
import { QUOTA_PERMISSIONS } from './quotas.permissions.js';
import { QuotaPolicy } from './quotas.policy.js';
import { QuotaMetrics } from './quota.metrics.js';
import { QuotasService } from './quotas.service.js';

/**
 * Tenant limits (README.md): QuotasService for the modules that own a
 * limited thing, the tenant's own use, and the operators' plans and per
 * tenant limits. A module registers what it limits in its own imports.
 */
@Module({
  imports: [
    AccessModule.forFeature(QUOTA_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
    MetricsModule,
  ],
  controllers: [QuotasController, OperatorQuotasController],
  providers: [QuotasService, QuotaPolicy, QuotaMetrics],
  exports: [QuotasService],
})
export class QuotasModule {
  /**
   * The quotas a module defines (`defineQuota()`). Re-exports QuotasModule,
   * so the module's services inject QuotasService.
   *
   * ```ts
   * @Module({ imports: [QuotasModule.forFeature(NOTE_QUOTA)], … })
   * ```
   */
  static forFeature(...quotas: Quota[]): DynamicModule {
    return {
      module: QuotaFeatureModule,
      imports: [QuotasModule],
      providers: [
        { provide: QuotaRegistration, useValue: new QuotaRegistration(quotas) },
      ],
      exports: [QuotasModule],
    };
  }
}

/** The host of one `QuotasModule.forFeature()` registration. */
@Module({})
class QuotaFeatureModule {}
