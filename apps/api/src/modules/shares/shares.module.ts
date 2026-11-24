import {
  Body,
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
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { httpConfig } from '../../core/http/http.config.js';
import { MailModule } from '../../core/mail/mail.module.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { definePermissions } from '../../iam/access/permissions.js';
import { UNIT_CONDITION_KEYS } from '../../iam/organization/unit-conditions.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordController,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import {
  type CreateShareDto,
  createdShareSchema,
  createShareSchema,
  MAX_SHARES_PER_RECORD,
  shareListSchema,
} from './share.schemas.js';
import { SharedController } from './shared.controller.js';
import { sharesConfig } from './shares.config.js';
import { ShareCodeMail } from './shares.mail.js';
import {
  SHARE_ACTION,
  SHARES_CAPABILITY,
  SharesService,
} from './shares.service.js';
import { SharesPersonalData } from './shares.personal-data.js';
import { SharesRepository } from './shares.repository.js';

/**
 * What a record that can be shared tells the engine: its list description
 * says `capabilities.shares`, and its links go when it is purged.
 */
@RecordExtension()
@Injectable()
class SharesExtension implements RecordHooks {
  readonly capability = SHARES_CAPABILITY;

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly shares: SharesService,
  ) {}

  async purged({ ids }: { ids: readonly string[] }) {
    await this.shares.forget(this.record.subject, ids);
  }
}

/**
 * The `share` action of a record's subject: read-only links to it. Its
 * conditions are the record's `read` ones (recordPermissions()); editors
 * share their own records.
 */
const sharePermissions = (record: RecordDeclaration) =>
  definePermissions({
    subjects: {
      [record.subject]: {
        actions: {
          [SHARE_ACTION]: record.unit
            ? ['mine', ...UNIT_CONDITION_KEYS]
            : ['mine'],
        },
      },
    },
    seedRoles: [
      {
        key: 'editor',
        permissions: [
          {
            subject: record.subject,
            action: SHARE_ACTION,
            conditions: [{ key: 'mine' }],
          },
        ],
      },
    ],
  });

/**
 * The public routes that open a shared link (`/v1/shared`, no sign-in); a
 * record opts in with `SharesModule.forRecord()`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(sharesConfig),
    ConfigModule.forFeature(httpConfig),
    AccessModule,
    AuditModule,
    AttachmentsModule,
    MailModule,
    RecordsModule,
  ],
  controllers: [SharedController],
  providers: [
    SharesService,
    SharesRepository,
    ShareCodeMail,
    SharesPersonalData,
  ],
  exports: [SharesService],
})
export class SharesModule {
  /**
   * Opts a record in: `GET|POST /v1/<path>/{id}/shares` and
   * `DELETE …/shares/{shareId}`, and the `share` action in its subject's
   * permissions. Imports SharesModule, so one import serves the routes
   * that open a link too.
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    const noun = record.noun;

    @ApiForbiddenResponse({ description: `You may not share the ${noun}.` })
    @ApiNotFoundResponse({ description: `No such ${noun} (or link).` })
    @RecordController(record, ':id/shares', 'Shares')
    class ShareRoutes {
      constructor(private readonly shares: SharesService) {}

      @Get()
      @Can.Anyone() // Checked by SharesService: the record's `share` action.
      @ApiOperation({
        summary: `The links of ${aNoun(record)}, newest first`,
        description:
          'Revoked and expired ones too (`active: false`); never their tokens.',
      })
      @ApiOkResponse({ standardSchema: shareListSchema })
      list(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
      ) {
        return this.shares.list(user, {
          subject: record.subject,
          recordId: id,
        });
      }

      @Post()
      @Can.Anyone()
      @ApiOperation({
        summary: `Share ${aNoun(record)} by a read-only link`,
        description: `A link that shows the chosen fields to whoever holds it, or only to \`recipientEmail\` with a mailed code, until \`expiresAt\` or until revoked. Only a person (not an API client, not while impersonating), and only fields you may read; it never shows more than you still may when it is opened. The token is in this answer only. At most ${MAX_SHARES_PER_RECORD} working links per ${noun}. Audited \`share.created\`.`,
      })
      @ApiCreatedResponse({ standardSchema: createdShareSchema })
      @ApiBadRequestResponse({
        description:
          'A field a link does not share, an expiry out of range, or too many links (validation_failed).',
      })
      create(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
        @Body({ schema: createShareSchema }) dto: CreateShareDto,
        @Ip() ip: string,
      ) {
        return this.shares.create(
          user,
          { subject: record.subject, recordId: id },
          dto,
          ip,
        );
      }

      @Delete(':shareId')
      @HttpCode(HttpStatus.NO_CONTENT)
      @Can.Anyone()
      @ApiOperation({
        summary: 'Revoke a link',
        description: `It stops opening at once. Its maker, or whoever may share the ${noun}. Audited \`share.revoked\`.`,
      })
      @ApiNoContentResponse()
      async revoke(
        @CurrentUser() user: RequestPrincipal,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('shareId', ParseUUIDPipe) shareId: string,
        @Ip() ip: string,
      ) {
        await this.shares.revoke(
          user,
          { subject: record.subject, recordId: id },
          shareId,
          ip,
        );
      }
    }

    return {
      module: SharedRecordModule,
      imports: [
        SharesModule,
        RecordsModule,
        AccessModule.forFeature(sharePermissions(record)),
      ],
      controllers: [ShareRoutes],
      providers: [{ provide: RECORD, useValue: record }, SharesExtension],
    };
  }
}

/** The host of one `SharesModule.forRecord()`. */
@Module({})
class SharedRecordModule {}
