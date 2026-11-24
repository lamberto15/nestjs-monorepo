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
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPreconditionFailedResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import {
  createdTenantSchema,
  createTenantSchema,
  requestDeletionSchema,
  tenantSchema,
  updateTenantSchema,
} from './tenants.schemas.js';
import {
  Etag,
  ifMatchHeader,
  ifNoneMatchHeader,
} from '../../core/http/etag.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { pageSchema } from '../../core/http/pagination.js';
import { OperatorOnly } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { TENANT_LIST } from './tenants.lists.js';
import { TenantsPolicy } from './tenants.policy.js';
import { TenantsService } from './tenants.service.js';

/**
 * The deployment's tenants, for its operators: the members of the
 * operators' tenant (`@OperatorOnly()`) holding `Access.manageTenants`.
 * Another tenant's administrator gets 403 `operator_required` whatever
 * their roles.
 */
@ApiTags('tenants')
@ApiCookieAuth('user-session')
@UserOnly()
@OperatorOnly()
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Get()
  @Can(TenantsPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'The tenants, newest first (operators)',
    description:
      'Filter flat (`?active=false&name.contains=acme`) or with `filter`, sort with `sort=name`, page with `cursor` or `page`, pick fields with `fields=slug,name`.',
  })
  @ApiOkResponse({ standardSchema: pageSchema(tenantSchema) })
  async list(@Query({ schema: TENANT_LIST.schema }) query: ListQuery) {
    return this.tenants.page(query);
  }

  @Get(':id')
  @Etag()
  @Can(TenantsPolicy, 'manageTenants')
  @ApiOperation({ summary: 'One tenant (operators)' })
  @ApiHeader(ifNoneMatchHeader())
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiNotFoundResponse()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tenants.get(id);
  }

  @Post()
  @Can(TenantsPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Create a tenant and invite its first administrator (operators)',
    description:
      'The tenant gets the built-in and declared roles; its first administrator is invited at `administratorEmail`. Audited (`tenant.created`) in your tenant and in the new one.',
  })
  @ApiCreatedResponse({ standardSchema: createdTenantSchema })
  @ApiConflictResponse({
    description:
      '`tenant_slug_taken` (on `errors[].path` `slug`); `single_tenant`: TENANCY=single has its one tenant.',
  })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createTenantSchema })
    body: z.infer<typeof createTenantSchema>,
    @Ip() ip: string,
  ) {
    return this.tenants.create(user, body, ip);
  }

  @Patch(':id')
  @Etag()
  @Can(TenantsPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Rename a tenant, change its slug, (de)activate it (operators)',
    description:
      'Audited (`tenant.updated`) in your tenant and in that one. Deactivated: its sessions and token families end, its API keys and jobs stop, its sockets close. Nothing is deleted: `active: true` gives it all back.',
  })
  @ApiHeader(ifMatchHeader())
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description:
      '`tenant_slug_taken`; `operator_tenant`: never deactivated; `tenant_deletion_pending`: cancel the deletion first.',
  })
  @ApiPreconditionFailedResponse({ description: '`precondition_failed`.' })
  update(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: updateTenantSchema })
    body: z.infer<typeof updateTenantSchema>,
    @Headers('if-match') ifMatch: string | undefined,
    @Ip() ip: string,
  ) {
    return this.tenants.update(user, id, body, ip, ifMatch);
  }

  @Post(':id/deletion')
  @Can(TenantsPolicy, 'manageTenants')
  @RecentAuthentication()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a tenant after a grace period (operators)',
    description:
      'Send its `slug` to confirm. Deactivated now, erased TENANT_DELETION_GRACE_DAYS later by a worker (`tenant.purged`, outside any tenant); DELETE cancels until then. Wants a recent sign-in.',
  })
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiBadRequestResponse({
    description: "`validation_failed` on `slug`: not this tenant's.",
  })
  @ApiNotFoundResponse()
  @ApiConflictResponse({
    description: '`operator_tenant`: never deleted.',
  })
  requestDeletion(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: requestDeletionSchema })
    body: z.infer<typeof requestDeletionSchema>,
    @Ip() ip: string,
  ) {
    return this.tenants.requestDeletion(user, id, body.slug, ip);
  }

  @Delete(':id/deletion')
  @Can(TenantsPolicy, 'manageTenants')
  @ApiOperation({
    summary: 'Keep a tenant: cancel its pending deletion (operators)',
    description:
      'Until the erase starts. The tenant stays deactivated: `PATCH { active: true }` brings it back.',
  })
  @ApiOkResponse({ standardSchema: tenantSchema })
  @ApiNotFoundResponse({ description: 'No deletion is pending.' })
  @ApiConflictResponse({
    description: '`tenant_deletion_started`: the erase is running.',
  })
  cancelDeletion(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.tenants.cancelDeletion(user, id, ip);
  }
}
