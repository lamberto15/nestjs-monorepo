import { Controller, Get, Param, Query } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Principal } from '../../iam/auth/principal.js';
import { listSchema } from '../../core/http/pagination.js';
import { listMetadataSchema } from './list-metadata.schemas.js';
import {
  type RecordOptionsQuery,
  recordOptionSchema,
  recordOptionsQuerySchema,
} from './record-options.schemas.js';
import { ListsService } from './lists.service.js';

/**
 * Each subject's list, described at runtime: what a generic table builds its
 * filter menus, sort and columns from, the same declaration the list route
 * validates with (docs/api-conventions.md, "List metadata").
 */
@ApiTags('lists')
@ApiBearerAuth('api-key')
@ApiBearerAuth('user-token')
@ApiCookieAuth('user-session')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@Controller('lists')
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get(':subject')
  @Can.Anyone() // ListsService checks it, on the subject.
  @ApiOperation({
    summary: "A subject's list: its filters, operators, sorts and fields",
    description:
      "The fields the list may be filtered and sorted by, with their operators, `fields=` names, search, the list's limits and what its add-ons add. A field your permissions hide is left out. For anyone who may read the subject.",
  })
  @ApiParam({
    name: 'subject',
    schema: { type: 'string', example: 'Note' },
    description: 'The kind of record, as permissions name it (`Note`).',
  })
  @ApiOkResponse({ standardSchema: listMetadataSchema })
  @ApiForbiddenResponse({ description: 'You may not read the subject.' })
  @ApiNotFoundResponse({ description: 'No list of that subject (not_found).' })
  async describe(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
  ) {
    return this.lists.describeFor(user, subject);
  }

  @Get(':subject/options')
  @Can.Anyone() // ListsService checks it, on the subject; the rows by the caller's read conditions.
  @ApiOperation({
    summary: "A record's options for a picker: ids and titles",
    description:
      "With `q` (or nothing): the live records whose title contains `q`, by title. Any other parameter is a filter of the subject's list, as GET /v1/lists/{subject} describes them and its own route takes them (`?productId=<id>`: the records of one parent, for a picker that depends on another). With `id=<id>,<id>`: the titles of these, for the names behind ids a page holds (a reference's cell, a filter's chips); an id you may not read is left out. Each item is an id and a title, nothing else. The title is the record's first text field, after its parent's title when one of its fields is unique within a reference (`Acme · Standard plan`), as a reference's `?include=` gives it; `q` matches the record's own. For anyone who may read the subject: only the records you may read.",
  })
  @ApiParam({
    name: 'subject',
    schema: { type: 'string', example: 'Customer' },
    description: 'The kind of record, as permissions name it (`Customer`).',
  })
  @ApiOkResponse({ standardSchema: listSchema(recordOptionSchema) })
  @ApiBadRequestResponse({
    description:
      '`q` empty or longer than 100 characters, `limit` over 20, an `id` that is no uuid, more than 20 ids, `q` with `id`, a filter the list does not declare or a value it refuses, or `sort`, `cursor`, `page`, `count`, `fields` or `deleted` (validation_failed).',
  })
  @ApiForbiddenResponse({
    description:
      'You may not read the subject, or a filter uses a field you may not read (field_forbidden).',
  })
  @ApiNotFoundResponse({
    description: 'No record of that subject (not_found).',
  })
  async options(
    @CurrentUser() user: Principal,
    @Param('subject') subject: string,
    @Query({ schema: recordOptionsQuerySchema }) query: RecordOptionsQuery,
  ) {
    return this.lists.optionsFor(user, subject, query);
  }
}
