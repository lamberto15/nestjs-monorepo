import { type DynamicModule, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { OperatorGuard } from '../../iam/auth/operator-only.js';
import { OrganizationModule } from '../../iam/organization/organization.module.js';
import { FlagGuard } from './flag.guard.js';
import { SettingsCache } from './settings.cache.js';
import { SettingsCatalog, SettingsRegistration } from './settings.catalog.js';
import { DASHBOARD_LAYOUT } from './dashboard.setting.js';
import { MONEY_CURRENCY } from './money.setting.js';
import { defineSettings } from './settings.types.js';
import { SettingsController } from './settings.controller.js';
import { SETTING_PERMISSIONS } from './settings.permissions.js';
import { SettingsPolicy } from './settings.policy.js';
import { SettingsRepository } from './settings.repository.js';
import { SettingsService } from './settings.service.js';
import type { SettingDeclaration } from './settings.types.js';
import { SettingsPersonalData } from './settings.personal-data.js';

/**
 * Settings and feature flags (README.md): the registry every module adds to
 * (`SettingsModule.forFeature()`), the cache with its invalidation across
 * instances, the settings API and `@RequireFlag()`. Import it once, in
 * `app.module.ts`; a module that declares settings imports
 * `SettingsModule.forFeature(DECLARATIONS)` instead, which brings this
 * module along and exports `SettingsService` and `FlagGuard`.
 * Needs DatabaseModule, TenancyModule, RedisModule, EncryptionModule and
 * what AccessModule needs.
 */
@Module({
  imports: [
    AccessModule.forFeature(SETTING_PERMISSIONS),
    AuditModule,
    OrganizationModule,
    DiscoveryModule,
  ],
  controllers: [SettingsController],
  providers: [
    // Declared here: neither the web dashboard nor money is a module of its own.
    {
      provide: SettingsRegistration,
      useValue: new SettingsRegistration(
        defineSettings([DASHBOARD_LAYOUT, MONEY_CURRENCY]),
      ),
    },
    SettingsCache,
    SettingsCatalog,
    SettingsService,
    SettingsRepository,
    SettingsPolicy,
    OperatorGuard,
    FlagGuard,
    SettingsPersonalData,
  ],
  exports: [SettingsService, FlagGuard],
})
export class SettingsModule {
  /**
   * A module's settings and flags: register them in the module that owns
   * them; the catalog finds every registration at startup and refuses an
   * inconsistent one. Re-exports SettingsModule, so the module's services
   * inject `SettingsService` and its routes may carry `@RequireFlag()`.
   *
   * ```ts
   * @Module({ imports: [SettingsModule.forFeature(NOTE_SETTINGS)], ... })
   * ```
   */
  static forFeature(
    declarations: readonly SettingDeclaration<any>[],
  ): DynamicModule {
    return {
      module: SettingsFeatureModule,
      imports: [SettingsModule],
      providers: [
        {
          provide: SettingsRegistration,
          useValue: new SettingsRegistration(declarations),
        },
      ],
      exports: [SettingsModule],
    };
  }
}

/** The host of one `SettingsModule.forFeature()` registration. */
@Module({})
class SettingsFeatureModule {}
