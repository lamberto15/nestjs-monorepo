import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { OpsBacklog } from './ops.backlog.js';
import { OpsController } from './ops.controller.js';
import {
  MailDiagnostic,
  OpsDiagnostics,
  WorkersDiagnostic,
} from './ops.diagnostics.js';
import { OpsEventStream } from './ops.events.js';
import { OPS_PERMISSIONS } from './ops.permissions.js';
import { OpsPolicy } from './ops.policy.js';
import { OpsService } from './ops.service.js';

/**
 * The operators' routes over the background work (README.md): queues and
 * their jobs, the outbox and its dead letters, workflows. Needs
 * QueuesModule, SharedOutboxModule and SharedWorkflowsModule (global),
 * AuthModule and AccessModule.
 */
@Module({
  imports: [
    AccessModule.forFeature(OPS_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
  ],
  controllers: [OpsController],
  providers: [
    OpsService,
    OpsPolicy,
    OpsBacklog,
    OpsDiagnostics,
    OpsEventStream,
    MailDiagnostic,
    WorkersDiagnostic,
  ],
  exports: [OpsService, OpsBacklog, OpsDiagnostics],
})
export class OpsModule {}
