import { Controller, Get, Query } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  DEFAULT_LIMIT,
  listSchema,
  MAX_LIMIT,
  pageSchema,
} from '../../core/http/pagination.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import {
  type PeopleQuery,
  peopleQuerySchema,
  personSchema,
  unitRefSchema,
  type UnitsQuery,
  unitsQuerySchema,
} from './people.schemas.js';
import { PeopleService } from './people.service.js';

/**
 * The tenant's people, as every member may see them: names and keys, for
 * @mention autocomplete and for the names behind keys a page holds. Users
 * only: an API client has no one to mention or pick.
 */
@ApiTags('people')
@UserOnly()
@Controller('people')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @Can.Anyone() // Any member of the tenant: only names and keys, of its members and former members.
  @ApiOperation({
    summary:
      "Your tenant's people, by name or by key: for @mentions and pickers",
    description:
      'With `q` (or nothing): the active members of your tenant whose name contains `q`, by name. With `key=user:<id>,client:<id>`: the names of these keys, in the order asked: a member, or a former member (they still own records), or an API client of your tenant; a key your tenant has no one for is left out (no error). Each item is a key and a name, nothing else.',
  })
  @ApiOkResponse({ standardSchema: listSchema(personSchema) })
  @ApiBadRequestResponse({
    description:
      '`q` empty or longer than 100 characters, `limit` over 20, a `key` that is not `user:<uuid>` or `client:<uuid>`, more than 20 keys, or `q` with `key` (validation_failed).',
  })
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  async list(@Query({ schema: peopleQuerySchema }) query: PeopleQuery) {
    return {
      items: query.key
        ? await this.people.named(query.key)
        : await this.people.directory(query.q, query.limit),
    };
  }
}

/**
 * The tenant's units, as every member may see them: id, name and place in
 * the tree, for pickers and the names of a `unitId`. Managing units (and
 * their members) stays on /v1/access/organizational-units. Users only.
 */
@ApiTags('people')
@UserOnly()
@Controller('organizational-units')
export class UnitDirectoryController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @Can.Anyone() // Any member of the tenant: only the units' ids, names and tree.
  @ApiOperation({
    summary: "Your tenant's organizational units: names and tree, for pickers",
    description: `Every organizational unit of your tenant, newest first in cursor pages (\`limit\`: ${DEFAULT_LIMIT} a page by default, ${MAX_LIMIT} at most; follow \`nextCursor\`): its id (what \`unitId\` holds), name, parent and depth, nothing else. \`q\`: a part of the name; \`id=<id>,<id>\`: these units (an id your tenant has no unit of is left out). For any member.`,
  })
  @ApiOkResponse({
    standardSchema: pageSchema(unitRefSchema).pick({
      items: true,
      nextCursor: true,
    }),
  })
  @ApiBadRequestResponse({
    description: 'A bad `q`, `id`, `limit` or `cursor` (validation_failed).',
  })
  @ApiForbiddenResponse({
    description: 'Your session acts in no tenant (tenant_required).',
  })
  list(@Query({ schema: unitsQuerySchema }) query: UnitsQuery) {
    return this.people.units(query);
  }
}
