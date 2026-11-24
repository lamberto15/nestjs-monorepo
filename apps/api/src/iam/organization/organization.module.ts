import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OrganizationController } from './organization.controller.js';
import { ORGANIZATION_PERMISSIONS } from './organization.permissions.js';
import { OrganizationPolicy } from './organization.policy.js';
import { OrganizationRepository } from './organization.repository.js';
import { OrganizationService } from './organization.service.js';
import { OrganizationUnitDirectory } from './unit-directory.provider.js';

/**
 * The tenant's organizational units (README.md): their tree, who belongs
 * to them, the routes under /access/organizational-units, and what access
 * reads of them (@UnitDirectory()). The unit conditions a feature's
 * subjects carry are in unit-conditions.ts. Imports AccessModule; access
 * never imports it.
 */
@Module({
  imports: [
    AccessModule.forFeature(ORGANIZATION_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
  ],
  controllers: [OrganizationController],
  providers: [
    OrganizationService,
    OrganizationRepository,
    OrganizationPolicy,
    OrganizationUnitDirectory,
  ],
  exports: [OrganizationService],
})
export class OrganizationModule {}
