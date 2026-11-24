import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { AuditLogRepository } from './audit-log.repository.js';
import { AuditLogService } from './audit-log.service.js';
import { AuditController } from './audit.controller.js';
import { AUDIT_PERMISSIONS } from './audit.permissions.js';
import { AuditPolicy } from './audit.policy.js';
import { AuditModule } from '../audit/audit.module.js';

/**
 * The audit pages (README.md): `GET /v1/access/audit` and
 * `GET /v1/access/sign-ins`, for whoever has `Access.readAudit`. Apart from
 * AuditModule because the routes need AccessModule, which itself writes
 * audit entries (a cycle otherwise). Needs what AccessModule needs.
 */
@Module({
  imports: [AccessModule.forFeature(AUDIT_PERMISSIONS), AuditModule],
  controllers: [AuditController],
  providers: [AuditPolicy, AuditLogService, AuditLogRepository],
  exports: [AuditPolicy],
})
export class AuditLogModule {}
