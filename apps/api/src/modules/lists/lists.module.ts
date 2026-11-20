import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditLogModule } from '../../iam/audit-log/audit-log.module.js';
import { RecordsModule } from '../records/records.module.js';
import { ListPolicy } from './list.policy.js';
import { ListsController } from './lists.controller.js';
import { ListsService } from './lists.service.js';

/** GET /v1/lists/{subject}: each record's list described at runtime (README.md). */
@Module({
  imports: [DiscoveryModule, RecordsModule, AccessModule, AuditLogModule],
  controllers: [ListsController],
  providers: [ListsService, ListPolicy],
  exports: [ListsService],
})
export class ListsModule {}
