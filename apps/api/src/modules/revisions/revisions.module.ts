import {
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  type DynamicModule,
  Module,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { ConfigModule } from '@nestjs/config';
import {
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
} from '@nestjs/swagger';
import { assertUnchanged, Etag, ifMatchHeader } from '../../core/http/etag.js';
import { ApiListQuery } from '../../core/http/list-docs.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { Principal } from '../../iam/auth/principal.js';
import { aNoun, type RecordDeclaration } from '../records/record.js';
import { RECORD, RecordController } from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { RevisionRetentionJob } from './revision-retention.job.js';
import { revisionsConfig } from './revisions.config.js';
import { RevisionsExtension } from './revisions.extension.js';
import { REVISION_LIST } from './revisions.list.js';
import {
  revisionDiffSchema,
  revisionPageSchema,
  revisionSchema,
} from './revisions.schemas.js';
import { RevisionsService } from './revisions.service.js';
import { RevisionsPersonalData } from './revisions.personal-data.js';

/** A revision number in the path: a positive integer, else 400. */
const revisionNumber = new ParseIntPipe({ errorHttpStatusCode: 400 });

/** The service and the nightly retention, once for every record that keeps revisions. */
@Module({
  imports: [
    ConfigModule.forFeature(revisionsConfig),
    RecordsModule,
    AccessModule,
    AuditModule,
  ],
  providers: [RevisionsService, RevisionRetentionJob, RevisionsPersonalData],
  exports: [RevisionsService],
})
class RevisionsCoreModule {}

/** One record's revisions: its extension and routes (one module per record). */
@Module({})
export class RevisionsModule {
  /**
   * A record keeps revisions: one per change, with what changed, and
   * `GET`/`POST` routes under `/<path>/{id}/revisions` (README.md). Import
   * it in the feature's module: `RevisionsModule.forRecord(NOTE)`.
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    const noun = record.noun;
    const a = aNoun(record);

    @ApiNotFoundResponse({
      description: `No such ${noun} (or you may not read it), or no such revision.`,
    })
    @RecordController(record, ':id/revisions', 'Revisions')
    class RevisionRoutes {
      constructor(private readonly revisions: RevisionsService) {}

      @Get()
      @Can.Anyone() // Checked by RevisionsService: reading the record.
      @ApiOperation({
        summary: `${a[0]!.toUpperCase()}${a.slice(1)}'s revisions, newest first`,
        description: `Revision 1 is the ${noun} as written; each change adds one, with what changed (\`changes\`, from → to). Cursor pages; \`?changedBy=user:<id>\`, \`?number.gte=\`.`,
      })
      @ApiOkResponse({ standardSchema: revisionPageSchema })
      @ApiListQuery(REVISION_LIST)
      async list(
        @CurrentUser() user: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Query() raw: Record<string, unknown>,
      ) {
        const query = REVISION_LIST.parse(raw);
        return REVISION_LIST.pick(
          await this.revisions.list(user, record.subject, id, query),
          query,
        );
      }

      @Get(':number')
      @Can.Anyone() // Checked by RevisionsService: reading the record.
      @ApiOperation({ summary: `One revision of ${a}` })
      @ApiOkResponse({ standardSchema: revisionSchema })
      get(
        @CurrentUser() user: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('number', revisionNumber) number: number,
      ) {
        return this.revisions.get(user, record.subject, id, number);
      }

      @Get(':a/diff/:b')
      @Can.Anyone() // Checked by RevisionsService: reading the record.
      @ApiOperation({
        summary: `What differs between two revisions of ${a}`,
        description: "From revision `a`'s values to `b`'s (either order).",
      })
      @ApiOkResponse({ standardSchema: revisionDiffSchema })
      diff(
        @CurrentUser() user: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('a', revisionNumber) from: number,
        @Param('b', revisionNumber) to: number,
      ) {
        return this.revisions.diff(user, record.subject, id, from, to);
      }

      @Post(':number/restore')
      @HttpCode(HttpStatus.OK)
      @Etag()
      @Can.Anyone() // Checked by RevisionsService: changing the record.
      @ApiOperation({
        summary: `Set ${a} back to a revision`,
        description: `Its values become the revision's, as a PATCH would set them (the same permissions, field-level ones too): audited \`${noun}.updated\`, and a new revision with \`restoredFrom\`. With If-Match (the ${noun}'s ETag), refused (412) if the ${noun} changed since you read it. Answers the ${noun}.`,
      })
      @ApiHeader(ifMatchHeader())
      @ApiForbiddenResponse({
        description: `You may not change the ${noun}, or a field it would set (field_forbidden).`,
      })
      @ApiPreconditionFailedResponse({
        description: `The ${noun} changed since you read it (precondition_failed).`,
      })
      restore(
        @CurrentUser() user: Principal,
        @Param('id', ParseUUIDPipe) id: string,
        @Param('number', revisionNumber) number: number,
        @Headers('if-match') ifMatch: string | undefined,
      ) {
        return this.revisions.restore(
          user,
          record.subject,
          id,
          number,
          (current) => assertUnchanged(ifMatch, current),
        );
      }
    }

    return {
      module: RevisionsModule,
      imports: [RecordsModule, RevisionsCoreModule],
      controllers: [RevisionRoutes],
      providers: [{ provide: RECORD, useValue: record }, RevisionsExtension],
    };
  }
}
