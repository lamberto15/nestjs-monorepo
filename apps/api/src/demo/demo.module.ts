import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { tenancyConfig } from '../core/tenancy/tenancy.config.js';
import { AccessModule } from '../iam/access/access.module.js';
import { AuditModule } from '../iam/audit/audit.module.js';
import { OrganizationModule } from '../iam/organization/organization.module.js';
import { TenantsModule } from '../iam/tenants/tenants.module.js';
import { DEMO_PERMISSIONS } from './demo.jobs.js';
import { DemoSeeder } from './demo.seeder.js';

/**
 * The demo seed (README.md): what `pnpm db:seed:demo` boots with the app
 * (seed-demo.ts), never the API or the worker. Needs the database, tenancy,
 * auth and password hashing the app provides.
 */
@Module({
  imports: [
    AccessModule.forFeature(DEMO_PERMISSIONS),
    AuditModule,
    OrganizationModule,
    TenantsModule,
    ConfigModule.forFeature(tenancyConfig),
  ],
  providers: [DemoSeeder],
})
export class DemoModule {}
