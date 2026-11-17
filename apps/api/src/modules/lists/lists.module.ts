import { Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { RecordsModule } from '../records/records.module.js';
import { ListPolicy } from './list.policy.js';
import { ListsController } from './lists.controller.js';
import { ListsService } from './lists.service.js';

/** GET /v1/lists/{subject}: each record's list described at runtime (README.md). */
@Module({
  imports: [RecordsModule, AccessModule],
  controllers: [ListsController],
  providers: [ListsService, ListPolicy],
  exports: [ListsService],
})
export class ListsModule {}
