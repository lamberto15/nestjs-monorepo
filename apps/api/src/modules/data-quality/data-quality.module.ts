import { BullModule } from '@nestjs/bullmq';
import {
  type DynamicModule,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { DiscoveryModule } from '@nestjs/core';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordController,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { Records } from '../records/records.service.js';
import { RecordsModule } from '../records/records.module.js';
import { DataQualityController } from './data-quality.controller.js';
import { DATA_QUALITY_PERMISSIONS } from './data-quality.permissions.js';
import { DataQualityPolicy } from './data-quality.policy.js';
import { DataQualityProcessor } from './data-quality.processor.js';
import {
  DataQualityRegistration,
  DataQualityRegistry,
  type QualityChecks,
} from './data-quality.registry.js';
import {
  dataQualityFindingPageSchema,
  type FindingsQuery,
  findingsQuerySchema,
} from './data-quality.schemas.js';
import {
  DATA_QUALITY_QUEUE,
  DataQualityService,
} from './data-quality.service.js';

/**
 * Data quality (README.md): the findings API, the scans on the
 * `data-quality` queue and its processor. A record opts in with
 * `DataQualityModule.forRecord(RECORD, checks)` in its feature module's
 * imports. Needs QueuesModule, AuthModule (global), the tenancy and
 * database modules, and the records of the features that opt in.
 */
@Module({
  imports: [
    AccessModule.forFeature(DATA_QUALITY_PERMISSIONS),
    AuditModule,
    DiscoveryModule,
    RecordsModule,
    BullModule.registerQueue({
      name: DATA_QUALITY_QUEUE,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [DataQualityController],
  providers: [
    DataQualityRegistry,
    DataQualityService,
    DataQualityPolicy,
    DataQualityProcessor,
  ],
  exports: [DataQualityService, DataQualityPolicy],
})
export class DataQualityModule {
  /**
   * Checks a record's data: `recommended` fields left empty, `duplicates`
   * of a field's value, and `rules` written in the expression language
   * (its `ref` fields are always checked for a record in the recycle bin).
   * Adds `GET /v1/<path>/{id}/data-quality`.
   *
   * ```ts
   * DataQualityModule.forRecord(CUSTOMER, {
   *   recommended: ['email'],
   *   duplicates: ['name'],
   *   rules: [{ name: 'paid-has-date', expect: "status != 'paid' or paidOn != null", severity: 'error' }],
   * })
   * ```
   */
  static forRecord(
    record: RecordDeclaration,
    checks: QualityChecks = {},
  ): DynamicModule {
    @RecordExtension()
    @Injectable()
    class DataQualityExtension implements RecordHooks {
      constructor(
        @InjectRecord() readonly record: RecordDeclaration,
        private readonly quality: DataQualityService,
      ) {}

      /** Findings of records gone for good go with them. */
      purged({ ids }: { ids: readonly string[] }) {
        return this.quality.forget(this.record.subject, ids);
      }
    }

    @RecordController(record, ':id/data-quality', 'DataQuality')
    class DataQualityRoutes {
      constructor(
        private readonly records: Records,
        private readonly quality: DataQualityService,
      ) {}

      @Get()
      @Can(DataQualityPolicy, 'read')
      @ApiOperation({
        summary: `The data-quality findings of one ${record.noun}`,
        description:
          'Open ones unless `dismissed=true`; only on fields shown to you.',
      })
      @ApiOkResponse({ standardSchema: dataQualityFindingPageSchema })
      @ApiNotFoundResponse({ description: 'No such record that you may read.' })
      async findings(
        @CurrentUser() user: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Query({ schema: findingsQuerySchema }) query: FindingsQuery,
      ) {
        await this.records
          .of(record.subject)
          .store.findOne(id, { visibleTo: user });
        return this.quality.findings(user, record.subject, query, id);
      }
    }

    return {
      module: DataQualityRecordModule,
      imports: [RecordsModule, DataQualityModule],
      controllers: [DataQualityRoutes],
      providers: [
        { provide: RECORD, useValue: record },
        {
          provide: DataQualityRegistration,
          useValue: new DataQualityRegistration(record, checks),
        },
        DataQualityExtension,
      ],
    };
  }
}

/** The host of one `DataQualityModule.forRecord()`. */
@Module({})
class DataQualityRecordModule {}
