import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AccessModule } from '../../iam/access/access.module.js';
import { RecordsModule } from '../records/records.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** GET /v1/search: the records of every feature that declares searchable fields (README.md). */
@Module({
  imports: [DiscoveryModule, RecordsModule, AccessModule],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
