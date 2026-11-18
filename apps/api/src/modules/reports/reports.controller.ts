import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
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
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { REPORT_LIST } from './reports.lists.js';
import {
  type CreateReportDto,
  createReportSchema,
  reportRunSchema,
  reportSchema,
  type UpdateReportDto,
  updateReportSchema,
} from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

const VALIDATION =
  'An export you may not run (`exporter`), filters or a sort its list refuses (`filters.<field>`, `sort`), a bad schedule or time zone, more than 20 active reports (validation_failed).';
const FIELD_FORBIDDEN =
  'The filters use a field your permissions hide (field_forbidden).';

/**
 * Scheduled reports: an export run for you on a schedule, its file mailed
 * to the recipients. Users and API clients each see and change only their
 * own (another's is a 404); what may be exported is what `GET /v1/data`
 * lists for the caller.
 */
@ApiTags('reports')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Can.Anyone() // Each report is its owner's; the export's own permission is checked.
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your scheduled reports',
    description:
      '`?active=true`, `?exporter=`, `?name.contains=`, `?sort=nextRunAt`; newest first; cursor pages.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(reportSchema) })
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: REPORT_LIST.schema }) query: ListQuery,
  ) {
    return REPORT_LIST.pick(await this.reports.page(user, query), query);
  }

  @Post()
  @ApiOperation({
    summary: 'Schedule a report',
    description:
      'An export (the name, format, filters and sort of POST /v1/data/exports) run as you daily, weekly or monthly at an hour of `timezone`; each run mails the recipients a link to the file. At most 20 active reports. Audited (`report.created`).',
  })
  @ApiCreatedResponse({ standardSchema: reportSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({ description: FIELD_FORBIDDEN })
  create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: createReportSchema }) dto: CreateReportDto,
    @Ip() ip: string,
  ) {
    return this.reports.create(user, dto, ip);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of your scheduled reports' })
  @ApiOkResponse({ standardSchema: reportSchema })
  @ApiNotFoundResponse()
  get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reports.get(user, id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a scheduled report',
    description:
      'Only what is sent changes; the next run is computed again from now when the schedule, the zone or `active` is sent. Audited (`report.updated`).',
  })
  @ApiOkResponse({ standardSchema: reportSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({ description: FIELD_FORBIDDEN })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateReportSchema }) dto: UpdateReportDto,
    @Ip() ip: string,
  ) {
    return this.reports.update(user, id, dto, ip);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a scheduled report',
    description:
      'Its past files stay until they expire. Audited (`report.deleted`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.reports.remove(user, id, ip);
  }

  @Post(':id/run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Run a report now',
    description:
      'Starts its export at once (the schedule stays as it is); the recipients get the link as for a scheduled run. Audited (`report.ran`).',
  })
  @ApiAcceptedResponse({ standardSchema: reportRunSchema })
  @ApiBadRequestResponse({ description: VALIDATION })
  @ApiForbiddenResponse({ description: FIELD_FORBIDDEN })
  @ApiNotFoundResponse()
  run(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.reports.runNow(user, id, ip);
  }
}
