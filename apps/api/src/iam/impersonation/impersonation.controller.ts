import {
  Controller,
  HttpCode,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from '@nestjs/common';
import {
  CurrentSession,
  CurrentUser,
  type SessionRecord,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequiresSwitch } from '../auth/deployment-switch.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { SessionOnly } from '../auth/user-only.decorator.js';
import { ImpersonationPolicy } from './impersonation.policy.js';
import { ImpersonationService } from './impersonation.service.js';

/** Impersonation (IMPERSONATION=on): acting as a member, for support, and back. */
@ApiCookieAuth('user-session')
@Controller()
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @ApiTags('access')
  @Post('access/users/:id/impersonate')
  @RequiresSwitch('auth.impersonation', 'IMPERSONATION')
  @SessionOnly()
  @Can(ImpersonationPolicy, 'impersonate')
  @RecentAuthentication()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Act as this member (support)',
    description:
      "Replaces your session with one of the member's, in this tenant only, for IMPERSONATION_TTL_MINUTES. Never an administrator, never yourself, never nested, never someone holding what you couldn't grant. Everything done meanwhile is audited as `you as them`. Stop with POST /auth/impersonation/stop.",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not a member of this tenant.' })
  @ApiForbiddenResponse({
    description:
      '`administrator_not_impersonated`; `authority_required`: they hold permissions you don’t.',
  })
  @ApiConflictResponse({
    description: '`impersonating_yourself`, `already_impersonating`.',
  })
  async start(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const { cookie } = await this.impersonation.start(user, session, id, ip);
    res.append('Set-Cookie', cookie);
  }

  @ApiTags('auth')
  @Post('auth/impersonation/stop')
  @RequiresSwitch('auth.impersonation', 'IMPERSONATION')
  @SessionOnly()
  @Can.Anyone()
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop acting as another member' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: '`not_impersonating`.' })
  async stop(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: SessionRecord,
    @Res({ passthrough: true }) res: Response,
    @Ip() ip: string,
  ) {
    const { cookie } = await this.impersonation.stop(user, session, ip);
    res.append('Set-Cookie', cookie);
  }
}
