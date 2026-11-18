import {
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Injectable,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { ConfigType } from '@nestjs/config';
import { I18nContext } from '@nestjs/i18n';
import { minutes } from '@nestjs/throttler';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { IdempotentRoute } from '../../core/idempotency/idempotent-route.js';
import { i18nConfig } from '../../core/i18n/i18n.config.js';
import { pageQuerySchema, type PageQuery } from '../../core/http/pagination.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import { UserThrottle } from '../../iam/auth/user-throttle.guard.js';
import { type RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RecordController,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import {
  documentQueuedSchema,
  recordDocumentPageSchema,
} from './documents.schemas.js';
import { DocumentsService } from './documents.service.js';
import { DocumentSourceRegistration } from './documents.source.js';
import { PdfRenderer } from './pdf-renderer.js';

/**
 * What PDFs add to a record: `POST /<path>/{id}/pdf` and
 * `GET /<path>/{id}/documents` (documentRoutes), `capabilities.pdf` and
 * `documentTemplates` in its list's description, and, before the record
 * is deleted for good, the removal of its documents and files.
 */
@RecordExtension()
@Injectable()
export class DocumentsExtension implements RecordHooks {
  readonly capability = 'pdf';

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly source: DocumentSourceRegistration,
    private readonly documents: DocumentsService,
    private readonly renderer: PdfRenderer,
    @Inject(i18nConfig.KEY)
    private readonly i18n: ConfigType<typeof i18nConfig>,
  ) {}

  /** Documents are off without GOTENBERG_URL. */
  available() {
    return this.renderer.enabled;
  }

  /** What `POST …/pdf` can issue: the template in each language the server answers in. */
  async describe(_principal: Principal) {
    return {
      documentTemplates: this.i18n.locales.map((language) => ({
        id: this.source.template.name,
        language,
      })),
    };
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.documents.forget(this.record.subject, ids);
  }
}

/**
 * `POST /<path>/{id}/pdf`: a record as a PDF, asked for here, rendered by a
 * worker from the record's template, followed at /v1/documents/{id};
 * `GET /<path>/{id}/documents`: the record's documents, in progress and
 * issued.
 */
export function documentRoutes(record: RecordDeclaration): Type {
  const { noun } = record;

  @RecordController(record, ':id', 'Documents')
  class DocumentRoutes {
    constructor(
      private readonly documents: DocumentsService,
      private readonly i18n: I18nContext,
    ) {}

    @Post('pdf')
    @HttpCode(HttpStatus.ACCEPTED)
    @Can.Anyone() // Checked by DocumentsService: whoever may read the record.
    // A retry with the same key gets the first answer instead of a second document.
    @IdempotentRoute()
    // Each one is a Chromium render: 10 a minute per user (API clients have their quotas).
    @UserThrottle({ limit: 10, ttl: minutes(1) })
    @ApiOperation({
      summary: `Issue a PDF of the ${noun}`,
      description: [
        `Whoever may read the ${noun}. Answers at once with the document id; a worker renders the PDF in the request's language (\`?lang=\`, \`X-Lang\`, your saved language; right to left in Arabic) and your time zone, from the fields you may read.`,
        '',
        'Follow it at GET /v1/documents/{id}; your realtime connection hears `document.ready { id, subject, recordId }` (download it at GET /v1/documents/{id}/download) or `document.failed { id, subject, recordId, error }`. Audited (document.requested, document.issued).',
      ].join('\n'),
    })
    @ApiAcceptedResponse({ standardSchema: documentQueuedSchema })
    @ApiBadRequestResponse({ description: 'The Idempotency-Key is missing.' })
    @ApiNotFoundResponse()
    @ApiConflictResponse({
      description: `Your document of this ${noun}, in this language, is still being rendered (document_pending: its \`id\` is in the problem), or a request with this Idempotency-Key is still running.`,
    })
    @ApiTooManyRequestsResponse({
      description: 'More than 10 a minute from one user (rate_limited).',
    })
    @ApiUnprocessableEntityResponse({
      description: 'This Idempotency-Key was used for a different request.',
    })
    @ApiServiceUnavailableResponse({
      description:
        'PDF documents are not set up on this server (documents_unavailable: GOTENBERG_URL is unset).',
    })
    pdf(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Ip() ip: string,
    ) {
      return this.documents.request(user, {
        subject: record.subject,
        recordId: id,
        locale: this.i18n.locale,
        ip,
      });
    }

    @Get('documents')
    @Can.Anyone() // Checked by DocumentsService: whoever may read the record.
    @ApiOperation({
      summary: `The ${noun}'s documents, newest first`,
      description: `Whoever may read the ${noun}: the documents asked for (POST …/{id}/pdf, by anyone), queued and rendering ones too, with their template and language and who asked. A completed one is downloaded at GET /v1/documents/{id}/download, which takes the right to read every field it shows.`,
    })
    @ApiOkResponse({ standardSchema: recordDocumentPageSchema })
    @ApiNotFoundResponse()
    list(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query({ schema: pageQuerySchema }) query: PageQuery,
    ) {
      return this.documents.list(user, record.subject, id, query);
    }
  }
  return DocumentRoutes;
}
