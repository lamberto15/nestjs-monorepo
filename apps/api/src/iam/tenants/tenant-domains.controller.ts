import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import {
  createDomainSchema,
  domainSchema,
  domainsSchema,
} from './tenants.schemas.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { TenantDomainsService } from './tenant-domains.service.js';
import { TenantsPolicy } from './tenants.policy.js';

/**
 * The tenant's own domains (CUSTOM_DOMAINS), for its administrators
 * (`Access.manageDomains`): add a hostname, publish its TXT record, ask
 * for the check, remove it. Every change wants a recent sign-in.
 */
@ApiTags('tenants')
@ApiCookieAuth('user-session')
@UserOnly()
@Controller('branding/domains')
export class TenantDomainsController {
  constructor(private readonly domains: TenantDomainsService) {}

  @Get()
  @Can(TenantsPolicy, 'manageDomains')
  @ApiOperation({ summary: "The tenant's domains" })
  @ApiOkResponse({ standardSchema: domainsSchema })
  list() {
    return this.domains.list();
  }

  @Post()
  @Can(TenantsPolicy, 'manageDomains')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Add a domain to prove',
    description:
      'Answers the TXT record to publish; then POST /branding/domains/{id}/verify. Never an IP, a port, a reserved name or the app’s own domain.',
  })
  @ApiCreatedResponse({ standardSchema: domainSchema })
  @ApiBadRequestResponse({ description: '`invalid_hostname` on `hostname`.' })
  @ApiConflictResponse({
    description:
      '`domain_exists`: listed already; `branding_locked`: the operators lock the branding.',
  })
  @ApiNotFoundResponse({ description: '`feature_off`: CUSTOM_DOMAINS=off.' })
  create(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: createDomainSchema })
    body: z.infer<typeof createDomainSchema>,
    @Ip() ip: string,
  ) {
    return this.domains.create(user, body.hostname, ip);
  }

  @Post(':id/verify')
  @Can(TenantsPolicy, 'manageDomains')
  @RecentAuthentication()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Check the TXT record (queued)',
    description: 'Read the domain again for the outcome.',
  })
  @ApiAcceptedResponse()
  @ApiConflictResponse({ description: '`branding_locked`.' })
  @ApiNotFoundResponse()
  async verify(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.domains.requestVerification(user, id);
  }

  @Delete(':id')
  @Can(TenantsPolicy, 'manageDomains')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a domain',
    description: 'From now on the host names no tenant.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  remove(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Ip() ip: string,
  ) {
    return this.domains.remove(user, id, ip);
  }
}
