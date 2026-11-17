import { Body, Controller, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { Public, TokenService } from '@nestjs/authentication';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { SessionLifetime } from '../auth/session-lifetime.js';
import { Captcha } from '../captcha/captcha.decorator.js';
import { email } from './account.schemas.js';
import { AccountService } from './account.service.js';
import { NativeSignIn } from './native-sign-in.service.js';
import { codeVerifier } from './native-redirect.js';

const issueSchema = z.object({
  email,
  password: z.string().min(1).max(256),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .describe('With two-factor on: a code from the app.'),
  recoveryCode: z.string().max(64).optional(),
  tenantId: z
    .uuid()
    .optional()
    .describe(
      'The tenant the tokens act in (one of yours); left out: the last one chosen.',
    ),
});
const refreshToken = z.string().min(1).max(512);
const refreshSchema = z.object({ refreshToken });
const revokeSchema = z.object({ refreshToken });
const exchangeSchema = z.object({
  handoffCode: z
    .string()
    .min(1)
    .max(128)
    .describe(
      "The `code` a native sign-in handed over: the `redirectUri`'s, or POST /auth/magic-link/handoff's.",
    ),
  codeVerifier: codeVerifier.describe(
    'The PKCE verifier of its `codeChallenge`.',
  ),
  code: issueSchema.shape.code,
  recoveryCode: issueSchema.shape.recoveryCode,
  tenantId: issueSchema.shape.tenantId,
});
const tokensSchema = z.object({
  accessToken: z.string().describe('A JWT: `Authorization: Bearer …`.'),
  refreshToken: z.string().describe('Single use: POST /auth/token/refresh.'),
  expiresIn: z
    .number()
    .int()
    .describe('Seconds until the access token expires.'),
});

/**
 * Tokens for mobile apps and CLIs, which keep no cookies: a 15-minute access
 * token and a single-use refresh token. A refresh token presented twice
 * revokes its whole family (someone copied it). A user with two-factor on
 * sends a code too; without it, the answer is a 401 saying `mfa_required`.
 *
 * The same bot protection as the browser's sign-in (@Captcha): a native
 * app renders the challenge in a web view when a 403 captcha_required asks.
 */
@ApiTags('auth')
@Public()
@AllowInMaintenance() // sign-in, and the refresh that keeps a signed-in client signed in
@Controller('auth/token')
export class TokensController {
  constructor(
    private readonly tokens: TokenService,
    private readonly account: AccountService,
    private readonly lifetime: SessionLifetime,
    private readonly native: NativeSignIn,
  ) {}

  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures' })
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in a token client with a password' })
  @ApiOkResponse({ standardSchema: tokensSchema })
  @ApiUnauthorizedResponse({
    description:
      'Invalid credentials, or a second factor is required or wrong.',
  })
  issue(
    @Body({ schema: issueSchema }) body: z.infer<typeof issueSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.account.issueTokens(
      body.email,
      body.password,
      { code: body.code, recoveryCode: body.recoveryCode },
      { ip, userAgent },
      body.tenantId,
    );
  }

  // The code is 256 random bits, bound to its verifier and spent by any
  // wrong answer: nothing to guess, nor a bot check to ask for.
  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Post('exchange')
  @HttpCode(200)
  @ApiOperation({
    summary: "Sign in a native app with a sign-in's handoff code",
    description:
      "The code of a provider's sign-in started with `redirectUri` and `codeChallenge`, or of POST /auth/magic-link/handoff, with its PKCE verifier. Two-factor and `tenantId` as for POST /auth/token: without a code from the app, 401 `mfa_required` and the handoff code still works (for its minute); a wrong one spends it.",
  })
  @ApiOkResponse({ standardSchema: tokensSchema })
  @ApiUnauthorizedResponse({
    description:
      'Unknown, used or expired code or another verifier; a second factor required or wrong; `tenantId` not one of yours.',
  })
  exchange(
    @Body({ schema: exchangeSchema }) body: z.infer<typeof exchangeSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.native.exchange(
      {
        code: body.handoffCode,
        codeVerifier: body.codeVerifier,
        tenantId: body.tenantId,
        secondFactor: { code: body.code, recoveryCode: body.recoveryCode },
      },
      { ip, userAgent },
    );
  }

  // An unknown, expired or reused refresh token gets a 401.
  @Throttle({ default: { limit: 60, ttl: minutes(1) } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Renew the access token (rotates the refresh token)',
  })
  @ApiOkResponse({ standardSchema: tokensSchema })
  @ApiUnauthorizedResponse({
    description: 'Unknown, expired or reused refresh token.',
  })
  async refresh(
    @Body({ schema: refreshSchema }) body: z.infer<typeof refreshSchema>,
  ) {
    // A family past its tenant's session limits is refused (401) and revoked.
    await this.lifetime.assertRefreshable(body.refreshToken);
    return this.tokens.refresh(body.refreshToken);
  }

  @Post('revoke')
  @HttpCode(204)
  @ApiOperation({ summary: "Sign this app out (its refresh token's family)" })
  @ApiNoContentResponse()
  async revoke(
    @Body({ schema: revokeSchema }) body: z.infer<typeof revokeSchema>,
  ) {
    // RFC 7009: the answer is the same for unknown tokens.
    await this.tokens.revoke(body.refreshToken);
  }
}
