import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import { t } from '@nestjs/i18n';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { z } from 'zod';
import { RequiresSwitch } from '../../iam/auth/deployment-switch.js';
import type {
  RequestPrincipal,
  UserPrincipal,
} from '../../iam/auth/principal.js';
import { UserOnly } from '../../iam/auth/user-only.decorator.js';
import {
  clientQuotaSchema,
  type UsageQuery,
  usageQuerySchema,
  usageReportSchema,
} from './usage.schemas.js';
import { UsagePolicy } from './usage.policy.js';
import { UsageService } from './usage.service.js';

/**
 * API clients' usage: requests per UTC day and route, today included. An
 * administrator reads any client's and sets its daily quota; a client reads
 * its own.
 */
@ApiTags('usage')
@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })
@RequiresSwitch('usage.enabled', 'USAGE')
@Controller()
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('access/clients/:id/usage')
  @UserOnly()
  @Can(UsagePolicy, 'read')
  @ApiBearerAuth('user-token')
  @ApiCookieAuth('user-session')
  @ApiOperation({
    summary: "An API client's requests per day and route",
    description:
      'UTC days from `from` to `to`, both included (default: the last 30 days, at most 400). Today counts live.',
  })
  @ApiOkResponse({ standardSchema: usageReportSchema })
  @ApiBadRequestResponse({
    description:
      'A range that ends before it starts, or is longer than 400 days.',
  })
  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @ApiNotFoundResponse()
  clientUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Query({ schema: usageQuerySchema }) query: UsageQuery,
  ) {
    return this.usage.forClient(id, query);
  }

  @Put('access/clients/:id/daily-quota')
  @UserOnly()
  @Can(UsagePolicy, 'setClientQuota')
  @ApiBearerAuth('user-token')
  @ApiCookieAuth('user-session')
  @ApiOperation({
    summary: "Set or remove an API client's daily request quota",
    description:
      'Past it the client gets 429 `quota_exceeded` until midnight UTC; every response carries X-Quota-Limit and X-Quota-Remaining. Applies from its next request. Audited (`client.quota-changed`).',
  })
  @ApiOkResponse({ standardSchema: clientQuotaSchema })
  @ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })
  @ApiNotFoundResponse()
  setQuota(
    @CurrentUser() user: UserPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body({ schema: clientQuotaSchema })
    body: z.infer<typeof clientQuotaSchema>,
    @Ip() ip: string,
  ) {
    return this.usage.setQuota(user, id, body.dailyQuota, ip);
  }

  @Get('usage')
  @Can.Anyone()
  @ApiBearerAuth('api-key')
  @ApiOperation({
    summary: 'Your requests per day and route (API clients)',
    description:
      'UTC days from `from` to `to`, both included (default: the last 30 days, at most 400). Today counts live. With a daily quota, every response carries X-Quota-Limit and X-Quota-Remaining.',
  })
  @ApiOkResponse({ standardSchema: usageReportSchema })
  @ApiBadRequestResponse({
    description:
      'A range that ends before it starts, or is longer than 400 days.',
  })
  @ApiForbiddenResponse({
    description: 'Only API clients have usage: a user gets a 403.',
  })
  ownUsage(
    @CurrentUser() principal: RequestPrincipal,
    @Query({ schema: usageQuerySchema }) query: UsageQuery,
  ) {
    if (principal.kind !== 'client') {
      throw new ForbiddenException(t('usage.clientsOnly'));
    }
    return this.usage.report(principal.id, query);
  }
}
