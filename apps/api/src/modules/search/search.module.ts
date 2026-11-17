import { Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { RecordsModule } from '../records/records.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

/** GET /v1/search: the records of every feature that declares searchable fields (README.md). */
@Module({
  imports: [RecordsModule, AccessModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
