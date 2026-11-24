import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { httpConfig } from '../../core/http/http.config.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { ImagesModule } from '../images/images.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { StoredFilesModule } from '../storage/storage.release.js';
import {
  BrandingLogoUpload,
  BrandingDarkLogoUpload,
} from './branding-logo-upload.interceptor.js';
import {
  BrandingController,
  HostBrandingController,
  PublicBrandingController,
} from './branding.controller.js';
import { BRANDING_PERMISSIONS } from './branding.permissions.js';
import { BrandingPolicy } from './branding.policy.js';
import { BrandingRepository } from './branding.repository.js';
import { BrandingService } from './branding.service.js';
import { BRANDING_SETTINGS } from './branding.settings.js';

/**
 * A tenant's branding (README.md): colours and mail sender name as
 * settings, the logos on the private disk, the brand of a custom domain's
 * host before sign-in. Needs StorageModule (the disk). BrandingService is
 * exported for what mail and documents ask of it.
 */
@Module({
  imports: [
    AccessModule.forFeature(BRANDING_PERMISSIONS),
    AuditModule,
    ConfigModule.forFeature(httpConfig),
    DiscoveryModule,
    ImagesModule,
    SettingsModule.forFeature(BRANDING_SETTINGS),
    // StoredFiles: a replaced or removed logo's file goes after the commit.
    StoredFilesModule,
  ],
  controllers: [
    BrandingController,
    PublicBrandingController,
    HostBrandingController,
  ],
  providers: [
    BrandingService,
    BrandingRepository,
    BrandingPolicy,
    BrandingLogoUpload,
    BrandingDarkLogoUpload,
  ],
  exports: [BrandingService],
})
export class BrandingModule {}
