import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import type { Principal } from '../../iam/auth/principal.js';
import { hitSchema, searchQuerySchema } from './search.schemas.js';
import { SearchService } from './search.service.js';

/** One search box over every kind of record the caller may read. */
@ApiTags('search')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('search')
export class SearchController {
  constructor(private readonly searches: SearchService) {}

  @Get()
  @Can.Anyone() // Each record filters by what the caller may read.
  @ApiOperation({
    summary: 'Search every kind of record you may read',
    description:
      'Words match anywhere; "quoted words" as a phrase; -word excludes; or between words. Best matches first, across kinds; snippets mark the matches with <b>…</b>.',
  })
  @ApiOkResponse({ standardSchema: listSchema(hitSchema) })
  async search(
    @CurrentUser() user: Principal,
    @Query({ schema: searchQuerySchema })
    query: z.infer<typeof searchQuerySchema>,
  ) {
    return {
      items: await this.searches.search(user, query.q, {
        subject: query.subject,
        limit: query.limit,
      }),
    };
  }
}
