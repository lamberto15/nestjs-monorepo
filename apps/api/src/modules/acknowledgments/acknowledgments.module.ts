import {
  Body,
  Controller,
  Delete,
  type DynamicModule,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Ip,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { Principal } from '../../iam/auth/principal.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordController,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { Records } from '../records/records.service.js';
import { ACKNOWLEDGMENT_NOTIFICATIONS } from './acknowledgments.notifications.js';
import {
  type AcknowledgmentRemindDto,
  acknowledgmentRemindResultSchema,
  acknowledgmentRemindSchema,
  type AcknowledgmentRequestDto,
  acknowledgmentRequestSchema,
  acknowledgmentSchema,
  type AcknowledgmentStatusQuery,
  acknowledgmentStatusQuerySchema,
  acknowledgmentStatusSchema,
  type AcknowledgmentVersionQuery,
  acknowledgmentVersionQuerySchema,
  myAcknowledgmentListSchema,
} from './acknowledgments.schemas.js';
import { AcknowledgmentsRepository } from './acknowledgments.repository.js';
import { AcknowledgmentsService } from './acknowledgments.service.js';
import { AcknowledgmentsPersonalData } from './acknowledgments.personal-data.js';

/**
 * What acknowledgments add to a record's writes: each change of a record
 * someone was asked about makes a new version (to acknowledge again);
 * deleting it for good removes its requests.
 */
@RecordExtension()
@Injectable()
export class AcknowledgmentsExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly acknowledgments: AcknowledgmentsService,
  ) {}

  async updated({ after }: { after: Record<string, unknown> }) {
    await this.acknowledgments.bump(this.record.subject, after.id as string);
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.acknowledgments.forget(this.record.subject, ids);
  }
}

/** The caller's own acknowledgments, whatever the record. */
@ApiTags('acknowledgments')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('acknowledgments')
export class MyAcknowledgmentsController {
  constructor(private readonly acknowledgments: AcknowledgmentsService) {}

  @Get()
  @Can.Anyone() // Only the caller's own, of records they may read.
  @ApiOperation({
    summary: 'Acknowledgments asked of me',
    description:
      'Newest first, at most 100, of records you may read: `?status=pending` (default; of the current version only) or `acknowledged`.',
  })
  @ApiOkResponse({ standardSchema: myAcknowledgmentListSchema })
  mine(
    @CurrentUser() user: Principal,
    @Query({ schema: acknowledgmentStatusQuerySchema })
    query: AcknowledgmentStatusQuery,
  ) {
    return this.acknowledgments.mine(user, query.status);
  }
}

/**
 * Acknowledgments (README.md): the service and `GET /v1/acknowledgments`,
 * shared by every record that takes them. A feature's module imports
 * `AcknowledgmentsModule.forRecord(RECORD)` for each record.
 */
@Module({
  imports: [
    AccessModule,
    AuditModule,
    NotificationsModule,
    NotificationsModule.forFeature(ACKNOWLEDGMENT_NOTIFICATIONS),
    RecordsModule,
  ],
  controllers: [MyAcknowledgmentsController],
  providers: [
    AcknowledgmentsService,
    AcknowledgmentsRepository,
    AcknowledgmentsPersonalData,
  ],
  exports: [AcknowledgmentsService],
})
export class AcknowledgmentsModule {
  /** Acknowledgments of one record: its routes and its extension. */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: AcknowledgmentsRecordModule,
      imports: [RecordsModule, AcknowledgmentsModule],
      controllers: [acknowledgmentRoutes(record)],
      providers: [
        { provide: RECORD, useValue: record },
        AcknowledgmentsExtension,
      ],
    };
  }
}

/** The host of one `AcknowledgmentsModule.forRecord()`. */
@Module({})
class AcknowledgmentsRecordModule {}

/**
 * `/<path>/{id}/acknowledgment-requests`, `…/acknowledgments` and
 * `…/acknowledge`: whoever may change the record asks, reminds, withdraws
 * and reads the dashboard; the person asked acknowledges.
 */
function acknowledgmentRoutes(record: RecordDeclaration): Type {
  const a = aNoun(record);

  @ApiNotFoundResponse({
    description: `No such ${record.noun}, or you may not read it.`,
  })
  @RecordController(record, ':id', 'Acknowledgments')
  class AcknowledgmentRoutes {
    constructor(
      private readonly records: Records,
      private readonly authorization: AuthorizationService,
      private readonly acknowledgments: AcknowledgmentsService,
    ) {}

    /** The record, readable by the user (a 404 otherwise). */
    private async readable(user: Principal, id: string) {
      const row = await this.records
        .of(record.subject)
        .store.findOne(id, { visibleTo: user });
      return { subject: record.subject, row };
    }

    /** The record, which the user may change (a 403 when they may only read it). */
    private async changeable(user: Principal, id: string) {
      const found = await this.readable(user, id);
      await this.authorization.authorize(
        this.records.of(record.subject).feature.policy as unknown as Type<{
          update(...args: unknown[]): boolean;
        }>,
        'update',
        user,
        found.row,
      );
      return found;
    }

    @Post('acknowledgment-requests')
    @Can.Anyone() // Checked here: changing the record.
    @ApiOperation({
      summary: `Ask people to acknowledge ${a}`,
      description: `Whoever may change the ${record.noun}. Each person is asked about its current version (1, then one more with each change); those already asked keep their answer. They must be members who may read the ${record.noun}. They are told (\`acknowledgment.requested\`). Audited. An acknowledgment records that the person confirmed reading that version, and when; it is not a signature.`,
    })
    @ApiCreatedResponse({ standardSchema: acknowledgmentSchema.array() })
    @ApiBadRequestResponse({
      description:
        'A recipient is not a member who may read it (acknowledgment_recipient_invalid), or the deadline is past (acknowledgment_due_in_past).',
    })
    @ApiForbiddenResponse({
      description: `You may not change the ${record.noun}.`,
    })
    @ApiConflictResponse({
      description:
        'More than 500 people for one version (acknowledgment_limit).',
    })
    async request(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: acknowledgmentRequestSchema })
      body: AcknowledgmentRequestDto,
      @Ip() ip: string,
    ) {
      return this.acknowledgments.request(
        user,
        await this.changeable(user, id),
        body.recipients,
        body.dueAt,
        ip,
      );
    }

    @Get('acknowledgments')
    @Can.Anyone() // Checked here: changing the record.
    @ApiOperation({
      summary: `${a[0]!.toUpperCase()}${a.slice(1)}'s acknowledgments (completion dashboard)`,
      description: `Whoever may change the ${record.noun}: counts and each person's state for a version (\`?version=\`, default the current).`,
    })
    @ApiOkResponse({ standardSchema: acknowledgmentStatusSchema })
    @ApiForbiddenResponse({
      description: `You may not change the ${record.noun}.`,
    })
    async status(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query({ schema: acknowledgmentVersionQuerySchema })
      query: AcknowledgmentVersionQuery,
    ) {
      await this.changeable(user, id);
      return this.acknowledgments.status(record.subject, id, query.version);
    }

    @Post('acknowledgments/remind')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone() // Checked here: changing the record.
    @ApiOperation({
      summary: 'Remind those who have not acknowledged',
      description:
        'Whoever may change the record. Everyone still waiting, or the named `recipients`; nobody twice within 24 hours (`skipped`). Told with `acknowledgment.reminder`. Audited.',
    })
    @ApiOkResponse({ standardSchema: acknowledgmentRemindResultSchema })
    @ApiForbiddenResponse({
      description: `You may not change the ${record.noun}.`,
    })
    async remind(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: acknowledgmentRemindSchema })
      body: AcknowledgmentRemindDto,
      @Ip() ip: string,
    ) {
      return this.acknowledgments.remind(
        user,
        await this.changeable(user, id),
        body.recipients,
        ip,
      );
    }

    @Delete('acknowledgments/:acknowledgmentId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @Can.Anyone() // Checked here: changing the record.
    @ApiOperation({
      summary: 'Withdraw a request',
      description:
        'Whoever may change the record. Only one nobody has answered; an answer stays. Audited.',
    })
    @ApiNoContentResponse()
    @ApiForbiddenResponse({
      description: `You may not change the ${record.noun}.`,
    })
    @ApiConflictResponse({
      description: 'Already acknowledged (acknowledgment_answered).',
    })
    async withdraw(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Param('acknowledgmentId', ParseUUIDPipe) acknowledgmentId: string,
      @Ip() ip: string,
    ) {
      await this.acknowledgments.withdraw(
        user,
        await this.changeable(user, id),
        acknowledgmentId,
        ip,
      );
    }

    @Post('acknowledge')
    @HttpCode(HttpStatus.OK)
    @Can.Anyone() // Checked here: being asked, and reading the record.
    @ApiOperation({
      summary: `Acknowledge ${a}`,
      description: `The person asked, for the ${record.noun}'s current version; acknowledging again changes nothing. A 404 for anyone nobody asked. Audited (\`acknowledgment.acknowledged\`).`,
    })
    @ApiOkResponse({ standardSchema: acknowledgmentSchema })
    async acknowledge(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Ip() ip: string,
    ) {
      return this.acknowledgments.acknowledge(
        user,
        await this.readable(user, id),
        ip,
      );
    }
  }
  return AcknowledgmentRoutes;
}
