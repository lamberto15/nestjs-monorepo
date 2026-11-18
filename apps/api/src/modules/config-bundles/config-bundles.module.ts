import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CONFIG_BUNDLE_PERMISSIONS } from './config-bundles.permissions.js';
import { ConfigBundlePolicy } from './config-bundles.policy.js';
import { ConfigBundlesController } from './config-bundles.controller.js';
import { ConfigBundlesService } from './config-bundles.service.js';
import { BundleSections } from './config-bundles.sections.js';
import { RolesBundle } from './roles.bundle.js';
import { SettingsBundle } from './settings.bundle.js';

/**
 * Configuration bundles (README.md): export, preview and apply a tenant's
 * configuration as one file. The sections are providers other modules (and
 * this one: settings and roles) mark with `@BundleSection()`.
 */
@Module({
  imports: [
    AccessModule.forFeature(CONFIG_BUNDLE_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
    SettingsModule,
  ],
  controllers: [ConfigBundlesController],
  providers: [
    ConfigBundlesService,
    ConfigBundlePolicy,
    BundleSections,
    RolesBundle,
    SettingsBundle,
  ],
})
export class ConfigBundlesModule {}
