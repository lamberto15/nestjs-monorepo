import {
  Body,
  Controller,
  Get,
  HttpCode,
  Ip,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { listSchema } from '../../core/http/pagination.js';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../auth/onboarding.js';
import type { UserPrincipal } from '../auth/principal.js';
import { WithoutSso } from '../auth/sign-in-gate.js';
import { SessionOnly, UserOnly } from '../auth/user-only.decorator.js';
import { TenantSwitchService } from './tenant-switch.service.js';

const myTenantSchema = z.object({
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  operator: z
    .boolean()
    .describe(
      "The operators' tenant (OPERATOR_TENANT): its members run the deployment.",
    ),
  current: z.boolean().describe('The tenant this session or token acts in.'),
});

const switchSchema = z.object({
  tenantId: z.uuid().describe('One of GET /auth/tenants.'),
});

/**
 * A user's tenants and the switch between them. Token clients pick a
 * tenant when they sign in (`tid`); a browser session switches here.
 */
@ApiTags('auth')
@ApiCookieAuth('user-session')
@Controller('auth')
export class TenantSwitchController {
  constructor(private readonly switcher: TenantSwitchService) {}

  @UserOnly()
  @Can.Anyone()
  @DuringMfaEnrollment()
  @DuringOnboarding()
  @WithoutSso()
  @Get('tenants')
  @AllowInMaintenance() // an operator finds the way back to the operators' tenant
  @ApiOperation({
    summary: 'The tenants you belong to',
    description:
      'The active memberships of active tenants, the last chosen first. `current` is the one this session acts in. While impersonating, only that one.',
  })
  @ApiOkResponse({ standardSchema: listSchema(myTenantSchema) })
  async tenants(@CurrentUser() user: UserPrincipal) {
    return { items: await this.switcher.tenantsOf(user) };
  }

  @SessionOnly()
  @Can.Anyone()
  @DuringMfaEnrollment()
  @DuringOnboarding()
  @WithoutSso()
  @Post('tenant')
  @AllowInMaintenance() // ...and takes it
  @HttpCode(204)
  @ApiOperation({
    summary: 'Act in another of your tenants',
    description:
      'Re-issues the session (a new cookie) in that tenant, without its recent sign-in: a sensitive action there asks for one again. Never while impersonating.',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({
    description: '`tenant_not_found`: not one of your tenants.',
  })
  @ApiForbiddenResponse({ description: '`not_while_impersonating`.' })
  async switch(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord,
    @Body({ schema: switchSchema }) body: z.infer<typeof switchSchema>,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const issued = await this.switcher.switch(user, session, body.tenantId, ip);
    if (!issued) {
      throw new UnauthorizedException(); // signed out meanwhile
    }
    res.append('Set-Cookie', issued.cookie);
  }
}
