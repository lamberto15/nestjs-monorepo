import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ClsModule } from 'nestjs-cls';
import { EncryptionTenant } from '../encryption/encryption.service.js';
import './tenancy-errors.js';
import { tenancyConfig } from './tenancy.config.js';
import { Tenancy } from './tenancy.service.js';
import { currentTenantScope } from './tenant-scope.js';

/**
 * Tenancy (README.md): the `Tenancy` service for every module (global), a
 * context per request in which a guard enters the request's tenant
 * (nestjs-cls's middleware), and the current tenant for core/encryption.
 * The wall itself is the database's: DatabaseModule's pool binds every
 * query to the scope (tenant-isolation.ts).
 */
@Global()
@Module({
  imports: [
    ConfigModule.forFeature(tenancyConfig),
    ClsModule.forRoot({ global: true, middleware: { mount: true } }),
  ],
  providers: [
    Tenancy,
    {
      provide: EncryptionTenant,
      useValue: {
        current: () => currentTenantScope()?.tenantId ?? undefined,
      } satisfies EncryptionTenant,
    },
  ],
  exports: [Tenancy, EncryptionTenant],
})
export class TenancyModule {}
