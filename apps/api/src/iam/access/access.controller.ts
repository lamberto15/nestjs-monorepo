import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import {
  Etag,
  etagOf,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { listSchema, pageSchema } from '../../core/http/pagination.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { PRINCIPAL_LIST, USER_LIST } from './access.lists.js';
import { AccessPolicy } from './access.policy.js';
import {
  catalogSchema,
  createdRoleSchema,
  explainQuerySchema,
  explanationSchema,
  principalSchema,
  roleInputSchema,
  roleViewSchema,
  updateMemberSchema,
  userViewSchema,
} from './access.schemas.js';
import { ExplanationService } from './explanation.service.js';
import { MembersService } from './members.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { PrincipalsService } from './principals.service.js';
import { RolesService } from './roles.service.js';

/**
 * Access administration: the catalog, roles, members' roles and
 * activation, and the explanation of access. User sessions only (an API
 * key never reaches it), each route behind its own permission. You can
 * only grant what you hold yourself without conditions.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@Controller('access')
export class AccessController {
  constructor(
    private readonly catalog: PermissionCatalog,
    private readonly roles: RolesService,
    private readonly members: MembersService,
    private readonly principals: PrincipalsService,
    private readonly explanations: ExplanationService,
  ) {}

  @Get('catalog')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary:
      'Every permission that exists: subjects, actions and the conditions each may carry; and the system jobs, with what each may do',
  })
  @ApiOkResponse({ standardSchema: catalogSchema })
  catalogView() {
    return {
      subjects: this.catalog.view(),
      // Who acts without a user (`system:<key>` in the audit log), and its permissions.
      systemJobs: this.catalog.systemJobsView(),
    };
  }

  @Get('roles')
  @Can(AccessPolicy, 'openForSso')
  @ApiOperation({
    summary: 'The roles, with their permissions and member counts',
  })
  @ApiOkResponse({ standardSchema: listSchema(roleViewSchema) })
  async roleList() {
    return { items: await this.roles.list() };
  }

  @Get('roles/:id')
  @Etag()
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'One role, with its permissions and member count',
    description:
      'Its `ETag` covers the role itself (name, description, permissions), not `members`: send it as `If-Match` with PATCH or DELETE.',
  })
  @ApiHeader(ifNoneMatchHeader())
  @ApiOkResponse({ standardSchema: roleViewSchema })
  @ApiNotFoundResponse()
  role(@Param('id', ParseUUIDPipe) id: string) {
    return this.roles.get(id);
  }

  @Post('roles')
  @Can(AccessPolicy, 'manageRoles')
  @ApiOperation({ summary: 'Create a role' })
  @ApiCreatedResponse({
    description: 'The new role id.',
    standardSchema: createdRoleSchema,
  })
  @ApiConflictResponse({ description: 'A role with this name exists.' })
  createRole(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: roleInputSchema }) body: z.infer<typeof roleInputSchema>,
    @Ip() ip: string,
  ) {
    return this.roles.create(user, body, ip);
  }

  @Patch('roles/:id')
  @Can(AccessPolicy, 'manageRoles')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Replace a role: name, description and permissions',
  })
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse({
    description: 'Saved; `ETag` is the role’s new tag (the next If-Match).',
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The built-in Administrator role.' })
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async updateRole(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: roleInputSchema }) body: z.infer<typeof roleInputSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    // If-Match under the role's lock: two administrators can't both win.
    await this.roles.update(user, id, body, ip, ifMatch);
    // The tag GET would now send, so the next write needs no read first.
    response.setHeader('ETag', etagOf(await this.roles.get(id)));
  }

  @Delete('roles/:id')
  @Can(AccessPolicy, 'manageRoles')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a role: its members lose its permissions' })
  @ApiHeader(ifMatchHeader())
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'The built-in Administrator role.' })
  @ApiPreconditionFailedResponse({
    description: 'It changed since you read it (precondition_failed).',
  })
  async deleteRole(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    await this.roles.remove(user, id, ip, ifMatch);
  }

  @Get('users')
  @Can(AccessPolicy, 'openForSso')
  @ApiOperation({
    summary: 'The users, with their role ids, newest first',
    description:
      "Filter flat (`?active=true&email.contains=@example.com`, a unit's current members with `?unitId=<id>` or `?unitId.in=<id>,<id>`: those in it, not in the units below) or with `filter` (and/or groups), sort with `sort=-createdAt`, pick fields with `fields=email,name`; each parameter lists what it takes.",
  })
  @ApiOkResponse({ standardSchema: pageSchema(userViewSchema) })
  async users(@Query({ schema: USER_LIST.schema }) query: ListQuery) {
    return this.members.page(query);
  }

  @Get('users/:id')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: 'One member of this tenant, with their role grants and units',
  })
  @ApiOkResponse({ standardSchema: userViewSchema })
  @ApiNotFoundResponse({ description: 'Not a member of this tenant.' })
  user(@Param('id', ParseUUIDPipe) id: string) {
    return this.members.get(id);
  }

  @Get('users/:id/explanation')
  @Can(AccessPolicy, 'explain')
  @ApiOperation({
    summary:
      'Why a member may or may not do each action on a subject, or on one of its records',
    description:
      "Computed by the authorization engine itself (the checks every route makes), per action: the answer, the fields it may touch, and each permission of the member's roles that could grant it, with whether it (and each of its conditions) reaches the record. The record is looked up as you: one you may not read is a 404. An answer that a field hidden from you decides is `null` (withheld). `Access.manageRoles` or `Access.manageUsers`.",
  })
  @ApiOkResponse({ standardSchema: explanationSchema })
  @ApiNotFoundResponse({
    description: 'Not a member of this tenant, or no record you may read.',
  })
  explain(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: explainQuerySchema })
    query: z.infer<typeof explainQuerySchema>,
  ) {
    return this.explanations.explain(user, id, query.subject, query.recordId);
  }

  @Patch('users/:id')
  @Can(AccessPolicy, 'manageUsers')
  // Roles are privileges; reactivating a membership brings its access back
  // (deactivating isn't asked).
  @RecentAuthentication({
    when: ({ body }) => {
      const sent = body as { roleIds?: unknown; active?: unknown } | undefined;
      return sent?.roleIds !== undefined || sent?.active === true;
    },
  })
  @HttpCode(204)
  @ApiOperation({
    summary: "Change a member's membership; only what is sent changes",
    description:
      "Its activation and roles in this tenant: never the account (its name, its password), which is its owner's. A deactivated member is refused from their next request in this tenant. The last active administrator stays.",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: 'Deactivating yourself, or removing the last administrator.',
  })
  async updateUser(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateMemberSchema })
    body: z.infer<typeof updateMemberSchema>,
    @Ip() ip: string,
  ) {
    await this.members.update(user, id, body, ip);
  }

  /**
   * The picker of whom a setting's override, a rollout or a filter is for:
   * the members and API clients the users and clients lists show, to the
   * same callers (`open`), searched by name or address.
   */
  @Get('principals')
  @Can(AccessPolicy, 'open')
  @ApiOperation({
    summary: "Search the tenant's users and API clients, as principal keys",
    description:
      "`?q=` matches a part of a user's name or address, or of a client's name, whatever the case (`%` and `_` are the characters); `?kind=user|client`, `?active=true`, `?sort=label`. Cursor pages. Each item's `key` (`user:<id>`, `client:<id>`) is what a setting's user scope takes as `scopeId`. Clients only while API_CLIENTS is on.",
  })
  @ApiOkResponse({ standardSchema: pageSchema(principalSchema) })
  async principalList(
    @Query({ schema: PRINCIPAL_LIST.schema }) query: ListQuery,
  ) {
    return this.principals.page(query);
  }
}
