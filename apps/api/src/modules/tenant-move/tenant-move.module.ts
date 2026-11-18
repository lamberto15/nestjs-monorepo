import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { PersonalDataModule } from '../../iam/personal-data/personal-data.module.js';
import { TenantsModule } from '../../iam/tenants/tenants.module.js';
import { TenantMoveService } from './tenant-move.service.js';

/**
 * Moving one tenant from a shared server to a server of its own
 * (README.md). No routes: the operator CLI's `tenant:*` commands drive
 * `TenantMoveService`, which it exports. Uses the app's disk (StorageModule)
 * and encryption keys (EncryptionModule), both global.
 */
@Module({
  imports: [
    ConfigModule.forFeature(tenancyConfig),
    AuditModule,
    PersonalDataModule,
    TenantsModule,
  ],
  providers: [TenantMoveService],
  exports: [TenantMoveService],
})
export class TenantMoveModule {}
