import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { StorageDisk, type StoredUpload } from '@nestjs/storage';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConsumes,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { pageSchema } from '../../core/http/pagination.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import {
  catalogSchema,
  type ExportDto,
  exportSchema,
  importFieldsSchema,
  importMappingSchema,
  startedSchema,
  statusSchema,
  templateQuerySchema,
  type TransfersQuery,
  transfersQuerySchema,
} from './data-transfer.schemas.js';
import { DataTransferService } from './data-transfer.service.js';
import { CONTENT_TYPES, formatOf } from './formats.js';
import {
  type ImportRequest,
  ImportUpload,
} from './import-upload.interceptor.js';
import { TRANSFERS_KEPT } from './transfer-retention.js';

/**
 * Exports and imports of the records that take them
 * (`DataTransferModule.forRecord()`), as CSV or Excel. The work runs on the
 * workers: the request answers 202, and GET /v1/data/transfers/{id} tells
 * the progress and the result.
 */
@ApiTags('data')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each route checks the record's own permission.
@Controller('data')
export class DataTransferController {
  constructor(
    private readonly transfers: DataTransferService,
    private readonly disk: StorageDisk,
  ) {}

  @Get()
  @ApiOperation({ summary: 'What you may export and import' })
  @ApiOkResponse({ standardSchema: catalogSchema })
  catalog(@CurrentUser() user: RequestPrincipal) {
    return this.transfers.catalog(user);
  }

  @Post('exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Export a list to a file (a background job)',
    description:
      'What the list route would show you with these filters and sort, every page of it, as CSV or Excel.',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  @ApiForbiddenResponse({
    description:
      'You may not read it (forbidden), or its filters use a field your permissions hide (field_forbidden).',
  })
  @ApiNotFoundResponse({ description: 'Nothing to export by that name.' })
  startExport(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: exportSchema }) body: ExportDto,
  ) {
    // Field by field: nothing a client sends reaches the code-only options (`tag`, `id`).
    return this.transfers.startExport(user, {
      name: body.name,
      format: body.format,
      filters: body.filters,
      sort: body.sort,
      timezone: body.timezone,
    });
  }

  @Post('imports')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(ImportUpload)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Import a file: every row is checked, valid rows are written (a background job)',
  })
  @ApiAcceptedResponse({ standardSchema: startedSchema })
  async startImport(
    @CurrentUser() user: RequestPrincipal,
    @Req() request: ImportRequest,
    @UploadedFile() file: StoredUpload | undefined,
    @Body({ schema: importFieldsSchema })
    body: z.infer<typeof importFieldsSchema>,
  ) {
    if (!file) {
      throw new BadRequestException('Attach the file as the "file" field.');
    }
    const format = formatOf(file.contentType);
    const mapping = parseMapping(body.mapping);
    if (!format || mapping === null) {
      // Refused: the upload must not stay on the disk.
      await this.disk.delete(file.key).catch(() => undefined);
      throw new BadRequestException(
        format
          ? 'The mapping is a JSON object: file header to template column, or null to ignore it.'
          : 'Send CSV or Excel (.xlsx).',
      );
    }
    return this.transfers.startImport(user, {
      name: body.name,
      key: file.key,
      format,
      dryRun: body.dryRun,
      matchOn: body.matchOn,
      mapping,
      limits: request.importLimits,
    });
  }

  @Get('imports/:name/template')
  @ApiOperation({
    summary: 'A file to fill for an import',
    description:
      'The columns you may import, as headers, and an example row: date-times in your time zone (named in the header), lists comma-separated. The Excel file adds a Columns sheet and dropdowns for the choices.',
  })
  @ApiProduces(...Object.values(CONTENT_TYPES))
  @ApiOkResponse({ description: 'The template file, as an attachment.' })
  @ApiNotFoundResponse()
  async template(
    @CurrentUser() user: RequestPrincipal,
    @Param('name') name: string,
    @Query({ schema: templateQuerySchema })
    query: z.infer<typeof templateQuerySchema>,
  ) {
    const { file, type, filename } = await this.transfers.template(
      user,
      name,
      query,
    );
    return new StreamableFile(file, {
      type,
      disposition: `attachment; filename="${filename}"`,
    });
  }

  @Get('transfers')
  @ApiOperation({
    summary: 'The exports and imports you started in this tenant',
    description:
      'Newest first, by cursor; `?kind=export|import`, `?status=`. Those started by you (or your scheduled reports), kept ' +
      TRANSFERS_KEPT +
      ' after they end. A filtered page may hold fewer than `limit` items while `nextCursor` is set: follow it until it is null.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(statusSchema) })
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: transfersQuerySchema }) query: TransfersQuery,
  ) {
    return this.transfers.list(user, query);
  }

  @Get('transfers/:id')
  @ApiOperation({
    summary:
      'An export or import you started: progress, then the result and its links',
  })
  @ApiOkResponse({ standardSchema: statusSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transfers.status(user, id);
  }
}

/** The `mapping` field: undefined when absent, null when it is no mapping. */
function parseMapping(raw: string | undefined) {
  if (raw === undefined || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const mapping = importMappingSchema.safeParse(parsed);
  return mapping.success ? mapping.data : null;
}
