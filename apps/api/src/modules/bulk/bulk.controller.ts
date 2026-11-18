import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { pageSchema } from '../../core/http/pagination.js';
import type { Principal, RequestPrincipal } from '../../iam/auth/principal.js';
import {
  bulkRunSchema,
  bulkStatusSchema,
  type RunsQuery,
  runsQuerySchema,
} from './bulk.schemas.js';
import { BulkService } from './bulk.service.js';

/**
 * The bulk runs a record's `POST /<path>/bulk` handed to the workers: their
 * progress, then their result. Only to the principal who started them.
 */
@ApiTags('bulk')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiBearerAuth('api-key')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('bulk')
export class BulkController {
  constructor(private readonly bulk: BulkService) {}

  @Get()
  @Can.Anyone() // Only the principal who started a run sees it.
  @ApiOperation({
    summary: 'The bulk runs you handed to the workers in this tenant',
    description:
      'Newest first, by cursor (`limit`, `cursor` = the previous `nextCursor`); `?status=` and `?kind=` keep some (a filtered page may hold fewer than `limit` items, or none, while `nextCursor` is set: follow it until it is null). Each item as GET /v1/bulk/{id} tells it, without the result per item (its counts stay). Runs answered in the request (200) were never jobs and are not listed; finished ones are kept 7 days.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(bulkRunSchema) })
  list(
    @CurrentUser() user: RequestPrincipal,
    @Query({ schema: runsQuerySchema }) query: RunsQuery,
  ) {
    return this.bulk.list(user, query);
  }

  @Get(':id')
  @Can.Anyone() // Only the principal who started it sees it.
  @ApiOperation({
    summary: 'A bulk run you started: progress, then the result per item',
    description:
      'The realtime connection hears `bulk.finished { id, subject, action, done, failed }` when it ends.',
  })
  @ApiOkResponse({ standardSchema: bulkStatusSchema })
  @ApiNotFoundResponse()
  status(
    @CurrentUser() user: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bulk.status(user, id);
  }
}
