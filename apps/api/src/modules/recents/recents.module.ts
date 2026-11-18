import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { RecentsController } from './recents.controller.js';
import { RecentsRegistry } from './recents.registry.js';
import { RecentsRetentionJob } from './recents.retention.job.js';
import { RecentsService } from './recents.service.js';
import { RecentsPersonalData } from './recents.personal-data.js';

/**
 * What recents add to a record whose opening is noted: nothing it shows
 * (the history is a table of its own, read at GET /v1/recents, so no read
 * of the record changes its ETag); its entries go when it is deleted for good.
 */
@RecordExtension()
@Injectable()
export class RecentsExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly recents: RecentsService,
    registry: RecentsRegistry,
  ) {
    registry.add(record.subject);
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.recents.forget(this.record.subject, ids);
  }
}

/**
 * Recent records (README.md): the `/recents` routes, the service and the
 * nightly sweep, shared by every record whose opening is noted. A feature's
 * module imports `RecentsModule.forRecord(RECORD)` for each record.
 */
@Module({
  imports: [RecordsModule],
  controllers: [RecentsController],
  providers: [
    RecentsService,
    RecentsRegistry,
    RecentsRetentionJob,
    RecentsPersonalData,
  ],
  exports: [RecentsService, RecentsRegistry],
})
export class RecentsModule {
  /** Recents for one record: its extension (the subject may be noted). */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: RecentsRecordModule,
      imports: [RecordsModule, RecentsModule],
      providers: [{ provide: RECORD, useValue: record }, RecentsExtension],
    };
  }
}

/** The host of one `RecentsModule.forRecord()`. */
@Module({})
class RecentsRecordModule {}
