import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Can } from '@nestjs/authorization';
import { CurrentUser } from '@nestjs/authentication';
import { Body, HttpCode, HttpStatus, Ip, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { NodeResponse } from '@nestjs/platform-node';
import { JobsModule } from '../../core/jobs/jobs.module.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import type { RecordDeclaration } from '../records/record.js';
import { RECORD } from '../records/record-extension.js';
import { RecordController } from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { RecordIdempotent } from '../records/record.routes.js';
import { bulkConfig } from './bulk.config.js';
import { BulkController } from './bulk.controller.js';
import { BulkExtension } from './bulk.extension.js';
import { BulkProcessor } from './bulk.processor.js';
import {
  actionsOf,
  bulkRequestSchema,
  bulkResultSchema,
  bulkStartedSchema,
} from './bulk.schemas.js';
import { BulkRepository } from './bulk.repository.js';
import { BulkService } from './bulk.service.js';
import { BULK, type BulkRequest } from './bulk.types.js';

/**
 * The runs every record with bulk operations shares: the `bulk` queue and
 * its processor, GET /v1/bulk and GET /v1/bulk/{id}. Imported by each
 * `BulkModule.forRecord()`; Nest builds it once.
 */
@Module({
  imports: [
    ConfigModule.forFeature(bulkConfig),
    AccessModule,
    AuditModule,
    JobsModule,
    RealtimeModule,
    RecordsModule,
    BullModule.registerQueue({
      name: BULK,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [BulkController],
  providers: [BulkService, BulkRepository, BulkProcessor],
  exports: [BulkService],
})
export class BulkRunsModule {}

/**
 * Bulk operations on a record (README.md): `POST /v1/<path>/bulk` deletes,
 * restores or changes many of its records at once, each as its own routes do.
 * The feature opts in with `BulkModule.forRecord(ITEM)` in its imports. Needs
 * QueuesModule and RedisModule.
 */
@Module({})
export class BulkModule {
  static forRecord(record: RecordDeclaration): DynamicModule {
    const body = bulkRequestSchema(record);
    const nouns = record.path.replace(/-/g, ' ');

    @RecordController(record, 'bulk', 'Bulk')
    class BulkRoutes {
      constructor(private readonly bulk: BulkService) {}

      @Post()
      @HttpCode(HttpStatus.OK)
      // A retry with the same key gets the first answer instead of acting twice.
      @RecordIdempotent(record)
      @Can.Anyone() // Checked by BulkService: the action's permission, then each record.
      @ApiOperation({
        summary: `${actionsOf(record).join(', ')} many ${nouns} at once`,
        description: `Each ${record.noun} as its own route does it (permission, field checks, hooks, audit entry); one that fails does not stop the others. Up to BULK_SYNC_LIMIT ids answer at once (200 with a result per id); more ids, and every \`filter\`, are a background job (202): follow it at GET /v1/bulk/{id}.`,
      })
      @ApiOkResponse({ standardSchema: bulkResultSchema })
      @ApiAcceptedResponse({ standardSchema: bulkStartedSchema })
      @ApiBadRequestResponse({
        description:
          'The body is invalid (validation_failed: ids and filter both or neither, an unknown action, a bad filter or input), more than 500 ids (bulk_too_many), or the Idempotency-Key is missing.',
      })
      @ApiForbiddenResponse({
        description:
          'You may not do this action at all, or filter by a field hidden from you.',
      })
      async runBulk(
        @CurrentUser() user: RequestPrincipal,
        @Body({ schema: body }) dto: Omit<BulkRequest, 'ip'>,
        @Ip() ip: string,
        @Res({ passthrough: true }) res: NodeResponse,
      ) {
        const outcome = await this.bulk.run(user, record.subject, {
          ...dto,
          ip,
        });
        if ('status' in outcome) res.status(HttpStatus.ACCEPTED);
        return outcome;
      }
    }

    return {
      module: BulkModule,
      imports: [BulkRunsModule, RecordsModule],
      controllers: [BulkRoutes],
      providers: [{ provide: RECORD, useValue: record }, BulkExtension],
    };
  }
}
