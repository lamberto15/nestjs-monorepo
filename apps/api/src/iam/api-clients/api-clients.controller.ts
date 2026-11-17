import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
import type { z } from 'zod';
import { listSchema } from '../../core/http/pagination.js';
import { AccessPolicy } from '../access/access.policy.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { RequiresSwitch } from '../auth/deployment-switch.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { ApiClientPolicy } from './api-clients.policy.js';
import {
  clientChangesSchema,
  clientViewSchema,
  clientWithKeySchema,
  createClientSchema,
  rotateSchema,
} from './api-clients.schemas.js';
import { ApiClientsService } from './api-clients.service.js';

/**
 * API clients and their keys, for administrators (user sessions only: an API
 * key never reaches it). Reading is open to whoever administers access;
 * changing needs `Access.manageClients`, and authority over what the client
 * may do.
 */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@ApiUnauthorizedResponse({ description: 'No session.' })
@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
@UserOnly()
@RequiresSwitch('auth.apiClients', 'API_CLIENTS')
@Controller('access/clients')
export class ApiClientsController {
  constructor(private readonly clients: ApiClientsService) {}

  @Get()
  @Can(AccessPolicy, 'open')
  @ApiOperation({ summary: 'The API clients (never their keys)' })
  @ApiOkResponse({ standardSchema: listSchema(clientViewSchema) })
  async list() {
    return { items: await this.clients.list() };
  }

  @Get(':id')
  @Can(AccessPolicy, 'open')
  @ApiOperation({ summary: 'One API client (never its keys)' })
  @ApiOkResponse({ standardSchema: clientViewSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.clients.get(id);
  }

  @Post()
  @Can(ApiClientPolicy, 'manageClients')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Create an API client: its key is in the response, this once',
    description: 'With its roles at once, in one transaction.',
  })
  @ApiCreatedResponse({ standardSchema: clientWithKeySchema })
  @ApiConflictResponse({ description: 'An API client with this name exists.' })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createClientSchema })
    body: z.infer<typeof createClientSchema>,
    @Ip() ip: string,
  ) {
    return this.clients.create(user, body, ip);
  }

  @Post(':id/rotate')
  @Can(ApiClientPolicy, 'manageClients')
  @RecentAuthentication()
  @HttpCode(200)
  @ApiOperation({
    summary: 'A new key; the current ones stop after graceSeconds (0: now)',
  })
  @ApiOkResponse({ standardSchema: clientWithKeySchema })
  @ApiNotFoundResponse()
  rotate(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: rotateSchema }) body: z.infer<typeof rotateSchema>,
    @Ip() ip: string,
  ) {
    return this.clients.rotate(user, id, body, ip);
  }

  @Delete(':id/keys/:keyId')
  @Can(ApiClientPolicy, 'manageClients')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke one key now' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async revokeKey(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @Ip() ip: string,
  ) {
    await this.clients.revokeKey(user, id, keyId, ip);
  }

  @Patch(':id')
  @Can(ApiClientPolicy, 'manageClients')
  // Roles are privileges; reactivating brings its keys back (revoking isn't asked).
  @RecentAuthentication({
    when: ({ body }) => {
      const sent = body as { roleIds?: unknown; active?: unknown } | undefined;
      return sent?.roleIds !== undefined || sent?.active === true;
    },
  })
  @ApiOperation({
    summary:
      'Revoke (active: false) or reactivate a client; change its roles or IP allowlist',
  })
  @ApiOkResponse({ standardSchema: clientViewSchema })
  @ApiNotFoundResponse()
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: clientChangesSchema })
    body: z.infer<typeof clientChangesSchema>,
    @Ip() ip: string,
  ) {
    return this.clients.update(user, id, body, ip);
  }

  @Delete(':id')
  @Can(ApiClientPolicy, 'manageClients')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete an API client for good: its keys stop at once',
    description:
      'Its keys and role grants go with it; the audit log keeps what it did. To stop it and keep it, revoke it instead (PATCH `active: false`).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    await this.clients.remove(user, id, ip);
  }
}
