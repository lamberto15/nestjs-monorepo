import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { impersonationConfig } from './impersonation.config.js';
import { ImpersonationController } from './impersonation.controller.js';
import { IMPERSONATION_PERMISSIONS } from './impersonation.permissions.js';
import { ImpersonationPolicy } from './impersonation.policy.js';
import { ImpersonationService } from './impersonation.service.js';

/**
 * Impersonation (README.md): starting and stopping it. Checking a running
 * one on every request is SessionAuth's (iam/auth), which ends it at its
 * time, with IMPERSONATION=off, or when either membership ends.
 */
@Module({
  imports: [
    AccessModule.forFeature(IMPERSONATION_PERMISSIONS),
    AuditModule,
    ConfigModule.forFeature(impersonationConfig),
  ],
  controllers: [ImpersonationController],
  providers: [ImpersonationService, ImpersonationPolicy],
})
export class ImpersonationModule {}
