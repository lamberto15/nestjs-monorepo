import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiOkResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { z } from 'zod';
import type { UserPrincipal } from '../auth/principal.js';
import { OperatorOnly } from '../auth/operator-only.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { AuthPolicyPolicy } from './auth-policy.policy.js';
import {
  authPolicySchema,
  requireMfaSchema,
  updateAuthPolicySchema,
} from './auth-policy.schemas.js';
import { TenantAuthPolicies } from './auth-policy.service.js';

/** The tenant's sign-in policy: two-factor, passwords, session lifetimes, break-glass. */
@ApiTags('access')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@UserOnly()
@Controller('access/auth-policy')
export class AuthPolicyController {
  constructor(private readonly policies: TenantAuthPolicies) {}

  @Get()
  @Can(AuthPolicyPolicy, 'read')
  @ApiOperation({ summary: "The tenant's sign-in policy" })
  @ApiOkResponse({ standardSchema: authPolicySchema })
  get(@CurrentUser() user: UserPrincipal) {
    return this.policies.get(user.tenantId!);
  }

  @Patch()
  @Can(AuthPolicyPolicy, 'update')
  @RecentAuthentication()
  @ApiOperation({
    summary: "Change the tenant's sign-in policy",
    description:
      "Only tightens the deployment's: a session limit over SESSION_IDLE_MINUTES or SESSION_MAX_HOURS, or two-factor required with AUTH_MFA off, is refused. null puts a value back to the deployment's. Audited (`auth-policy.updated`).",
  })
  @ApiOkResponse({ standardSchema: authPolicySchema })
  @ApiBadRequestResponse({
    description: "`setting_not_allowed`: over the deployment's ceiling.",
  })
  @ApiConflictResponse({
    description:
      '`mfa_enroll_first`: requiring two-factor while you have none would lock you out; set yours up first.',
  })
  update(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: updateAuthPolicySchema })
    body: z.infer<typeof updateAuthPolicySchema>,
    @Ip() ip: string,
  ) {
    return this.policies.update(user, user.tenantId!, body, ip);
  }

  @Get('units/:unitId')
  @Can(AuthPolicyPolicy, 'read')
  @ApiOperation({
    summary: "A unit's own two-factor requirement",
    description:
      'Not the tree above it: a unit also answers to the requirement of every unit above it.',
  })
  @ApiOkResponse({ standardSchema: requireMfaSchema })
  @ApiNotFoundResponse()
  unit(@Param('unitId', ParseUUIDPipe) unitId: string) {
    return this.policies.unitPolicy(unitId);
  }

  @Put('units/:unitId')
  @Can(AuthPolicyPolicy, 'update')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Require two-factor of a unit and the units under it',
    description:
      'Its members and those of the units below it must have two-factor, as with the tenant-wide requirement. `false` removes it. 409 `mfa_enroll_first` when you are covered and have none. Audited (`auth-policy.unit-updated`).',
  })
  @ApiOkResponse({ standardSchema: requireMfaSchema })
  @ApiBadRequestResponse({
    description: '`setting_not_allowed`: AUTH_MFA is off.',
  })
  @ApiConflictResponse({ description: '`mfa_enroll_first`.' })
  @ApiNotFoundResponse()
  updateUnit(
    @CurrentUser() user: UserPrincipal,
    @Param('unitId', ParseUUIDPipe) unitId: string,
    @Body({ schema: requireMfaSchema })
    body: z.infer<typeof requireMfaSchema>,
    @Ip() ip: string,
  ) {
    return this.policies.updateUnit(user, unitId, body.requireMfa, ip);
  }

  @Get('platform')
  @OperatorOnly()
  @Can(AuthPolicyPolicy, 'managePlatform')
  @ApiOperation({
    summary: "The operators' two-factor requirement for every tenant",
  })
  @ApiOkResponse({ standardSchema: requireMfaSchema })
  platform() {
    return this.policies.platformPolicy();
  }

  @Put('platform')
  @OperatorOnly()
  @Can(AuthPolicyPolicy, 'managePlatform')
  @RecentAuthentication()
  @ApiOperation({
    summary: 'Require two-factor of every member of every tenant',
    description:
      "Operators only. A tenant can't go below it: its own value, and its units', still apply, but this one holds everywhere. 409 `mfa_enroll_first` when you have none. Audited (`auth-policy.platform-updated`).",
  })
  @ApiOkResponse({ standardSchema: requireMfaSchema })
  @ApiBadRequestResponse({
    description: '`setting_not_allowed`: AUTH_MFA is off.',
  })
  @ApiConflictResponse({ description: '`mfa_enroll_first`.' })
  updatePlatform(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: requireMfaSchema })
    body: z.infer<typeof requireMfaSchema>,
    @Ip() ip: string,
  ) {
    return this.policies.updatePlatform(user, body.requireMfa, ip);
  }
}
