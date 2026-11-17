import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { auditConfig } from './audit.config.js';
import { AuditListeners } from './audit.listeners.js';
import { AuditRetentionJob } from './audit-retention.job.js';
import { AuditService } from './audit.service.js';

/**
 * The audit log (README.md): AuditService for the modules that record
 * their changes, the entries of what auth announces (AuditListeners, by
 * events), and the nightly retention job. Needs AuthModule (global),
 * EventEmitterModule.forRoot() and SharedLocksModule (the job's schedule
 * and lock).
 */
@Module({
  imports: [ConfigModule.forFeature(auditConfig), DiscoveryModule],
  providers: [AuditService, AuditListeners, AuditRetentionJob],
  exports: [AuditService],
})
export class AuditModule {}
