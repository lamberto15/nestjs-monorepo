import {
  Body,
  Controller,
  Delete,
  Inject,
  Ip,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { CurrentSession, CurrentUser, Public } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import type { ConfigType } from '@nestjs/config';
import { authConfig } from '../auth/auth.config.js';
import { SessionOnly } from '../auth/user-only.decorator.js';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { listSchema } from '../../core/http/pagination.js';
import { ProviderSignIn } from './provider-sign-in.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import {
  nativeCompletedSchema,
  nativeCompleteSchema,
  nativeTicketSchema,
  nativeTicketUrlSchema,
  oidcCallbackQuerySchema,
  oidcIdentitySchema,
  oidcLoginQuerySchema,
} from './account.schemas.js';
import { reauthenticationCookie } from './oidc-reauthentication.js';
import { OidcSignIn } from './oidc-sign-in.service.js';

/**
 * Sign in with Google, Microsoft or GitHub (OidcService: PKCE, nonce, state
 * bound to the browser). The browser navigates to `login`; the provider sends
 * it back to `callback`, which signs it in and redirects to the web app.
 * `?link=true` from a signed-in session connects the provider to the account.
 */
@ApiTags('auth')
@Controller('auth')
export class OidcController {
  constructor(
    private readonly flows: OidcSignIn,
    private readonly providers: ProviderSignIn,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  // Optional session: a link flow (?link=true) needs one (401), and not an
  // impersonation (403), and a recent sign-in: a provider linked by a stolen
  // session would let its thief back in at will. The browser navigates
  // here, so a stale sign-in is sent back to the web app with
  // `?error=reauthentication_required` instead of the guard's 403 problem,
  // which a navigation can't read; the web app asks GET /auth/reauthenticate
  // first to spare the round trip.
  // Each start keeps a pending sign-in for 10 minutes, at most 100,000 of
  // them (account.stores.ts): unthrottled, a few addresses would push
  // everyone else's out before their callback.
  @Throttle({ default: { limit: 20, ttl: minutes(15) } })
  @SessionOnly({ optional: true })
  @Can.Anyone()
  @Get('oidc/:provider/login')
  @AllowInMaintenance()
  @Redirect()
  @ApiOperation({
    summary: 'Start signing in with a provider (navigate the browser here)',
    description:
      'With `link=true`, a signed-in session that is not recent (REAUTHENTICATION_MAX_AGE_MINUTES) is redirected to the web app (`redirectTo`, else its root) with `?error=reauthentication_required`: check GET /auth/reauthenticate first. With `reauthenticate=true`, a signed-in user steps up through the provider: it is asked to authenticate them again (`prompt=login`, `max_age=0`), and the callback accepts only that user, authenticated at the provider after the start (`auth_time`, when the ID token has one); otherwise the browser lands on the web app with `?error=reauthentication_failed`, signed in as before.',
  })
  @ApiFoundResponse({
    description:
      'To the provider; or, linking from a stale session, to the web app with `?error=reauthentication_required`.',
  })
  async login(
    @CurrentUser() user: UserPrincipal | null,
    @CurrentSession() session: unknown,
    @Param('provider') provider: string,
    @Query({ schema: oidcLoginQuerySchema })
    query: z.infer<typeof oidcLoginQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { redirect, stepUpState } = await this.flows.login(
      user,
      session,
      provider,
      query,
    );
    if (stepUpState !== undefined) {
      res.append('Set-Cookie', this.stepUpCookie().set(stepUpState));
    }
    return redirect;
  }

  @Public()
  @Get('oidc/:provider/callback')
  @AllowInMaintenance()
  @Redirect()
  @ApiOperation({ summary: 'Where the provider sends the browser back' })
  @ApiFoundResponse({
    description:
      'To the web app; a refused step-up (`reauthenticate=true`) with `?error=reauthentication_failed`. A native login: to its `redirectUri` with `?code=`, or `?error=sign_in_failed`.',
  })
  async callback(
    @Param('provider') provider: string,
    @Query({ schema: oidcCallbackQuerySchema })
    query: z.infer<typeof oidcCallbackQuerySchema>,
    @Ip() ip: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = this.stepUpCookie();
    const { redirect, cookies, clearStepUp } = await this.flows.callback(
      provider,
      query,
      { ip, userAgent: firstHeader(req.headers['user-agent']) },
      cookie.read(req.headers.cookie),
    );
    for (const value of cookies) {
      res.append('Set-Cookie', value);
    }
    if (clearStepUp) {
      res.append('Set-Cookie', cookie.clear());
    }
    return redirect;
  }

  /** The step-up cookie, Secure (and `__Host-`) as the session's (SESSION_COOKIE_SECURE). */
  private stepUpCookie() {
    return reauthenticationCookie(this.auth.sessionCookieSecure);
  }

  @UserOnly()
  @Can.Anyone()
  @Get('identities')
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({ summary: 'The providers connected to your account' })
  @ApiOkResponse({ standardSchema: listSchema(oidcIdentitySchema) })
  async identities(@CurrentUser() user: UserPrincipal) {
    return { items: await this.providers.identities(user.id) };
  }

  // A browser session has `?link=true`; a token-only app asks for a ticket.
  // Linking wants a recent sign-in, as the browser's link does.
  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication({
    when: (request) =>
      (request as { body?: { purpose?: unknown } }).body?.purpose === 'link',
  })
  @Post('identities/:provider/native')
  @HttpCode(201)
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({
    summary: 'Link a provider, or step up through one, from a native app',
    description:
      'For an app signed in with tokens (a browser session: 400 `token_session_required`; use `?link=true` / `?reauthenticate=true`). Answers the `url` to open in the system browser: a one-time ticket, for five minutes, bound to you, this token session, the purpose, `redirectUri` (one of NATIVE_REDIRECT_URIS) and `codeChallenge`. A step-up asks the provider to authenticate you again. The browser lands on `redirectUri?code=…` (or `?error=link_failed` / `reauthentication_failed`): POST /auth/identities/native/complete with the verifier.',
  })
  @ApiCreatedResponse({
    standardSchema: nativeTicketUrlSchema,
  })
  async nativeTicket(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Param('provider') provider: string,
    @Body({ schema: nativeTicketSchema })
    body: z.infer<typeof nativeTicketSchema>,
  ) {
    return this.flows.nativeTicket(user, session, provider, body);
  }

  // The code is 256 random bits, bound to its verifier and this session.
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @UserOnly()
  @Can.Anyone()
  @Post('identities/native/complete')
  @HttpCode(200)
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({
    summary: 'Finish a native link or step-up with its handoff code',
    description:
      "With the token session that asked for the ticket. A link answers the identity (an identity already another account's was refused at the callback: `?error=link_failed`, nothing changed; connected to one since: 409 `identity_taken`). The link is written only now. A step-up answers new tokens with a fresh `auth_time`, as POST /auth/reauthenticate does for a password: send `refreshToken` to revoke the old pair. Two-factor on: without a code, 401 `mfa_required` and the handoff code still works (for its minute); a wrong one spends it.",
  })
  @ApiOkResponse({ standardSchema: nativeCompletedSchema })
  @ApiUnauthorizedResponse({
    description:
      'Unknown, used or expired code, another verifier, user or session; a second factor required or wrong.',
  })
  async nativeComplete(
    @CurrentUser() user: UserPrincipal,
    @CurrentSession() session: unknown,
    @Body({ schema: nativeCompleteSchema })
    body: z.infer<typeof nativeCompleteSchema>,
    @Ip() ip: string,
  ) {
    return this.flows.nativeComplete(
      user,
      session,
      {
        code: body.handoffCode,
        codeVerifier: body.codeVerifier,
        refreshToken: body.refreshToken,
        secondFactor: { code: body.code, recoveryCode: body.recoveryCode },
      },
      ip,
    );
  }

  @UserOnly()
  @Can.Anyone()
  @RecentAuthentication()
  @Delete('identities/:provider')
  @HttpCode(204)
  @ApiCookieAuth('user-session')
  @ApiBearerAuth('user-token')
  @ApiTags('account')
  @ApiOperation({ summary: 'Disconnect a provider' })
  @ApiNoContentResponse()
  @ApiConflictResponse({
    description:
      '`last_sign_in_method`: it is your only way to sign in (no password, passkey or other provider): set a password or register a passkey first.',
  })
  async unlink(
    @CurrentUser() user: UserPrincipal,
    @Param('provider') provider: string,
  ) {
    await this.flows.unlink(user, provider);
  }
}

const firstHeader = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;
