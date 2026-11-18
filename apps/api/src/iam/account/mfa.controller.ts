import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Ip,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import {
  CurrentUser,
  MfaAlreadyEnrolledError,
  MfaService,
  Public,
} from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import { t } from '@nestjs/i18n';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import type { UserPrincipal } from '../auth/principal.js';
import { RequiresSwitch } from '../auth/deployment-switch.js';
import { RecentAuthentication } from '../auth/recent-authentication.js';
import { UserOnly } from '../auth/user-only.decorator.js';
import { Captcha } from '../captcha/captcha.decorator.js';
import { DuringMfaEnrollment } from '../auth/mfa-enrollment.guard.js';
import { DuringOnboarding } from '../auth/onboarding.js';
import {
  notWhileImpersonating,
  signedInSchema,
  totpCode,
  verifiedEmailOnly,
} from './account.schemas.js';
import { AccountService } from './account.service.js';

const codeSchema = z.object({ code: totpCode });
const verifySchema = z
  .object({
    code: totpCode.optional(),
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine((body) => !!body.code !== !!body.recoveryCode, {
    message: 'Send a code or a recoveryCode.',
  });
const statusSchema = z.object({
  enabled: z.boolean(),
  remainingRecoveryCodes: z.number().int(),
});
const enrollmentSchema = z.object({
  secret: z.string().describe('Base32, for typing into the app by hand.'),
  uri: z.string().describe('otpauth:// URI: show it as a QR code.'),
});
const recoveryCodesSchema = z.object({
  recoveryCodes: z
    .array(z.string())
    .describe('Shown once: each one signs in once in place of a code.'),
});

/**
 * Two-factor authentication with an authenticator app (TOTP) and recovery
 * codes (MfaService). Enroll, confirm with a first code: from then on, a
 * sign-in asks for a code (POST /auth/mfa/verify). Changing or removing it
 * needs a session that passed the second factor; setting it up, new recovery
 * codes and turning it off want a recent sign-in (`@RecentAuthentication()`).
 */
@ApiTags('account')
@ApiCookieAuth('user-session')
@ApiBearerAuth('user-token')
@DuringMfaEnrollment()
@DuringOnboarding()
@Controller('auth/mfa')
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly account: AccountService,
  ) {}

  @Can.Anyone()
  @UserOnly()
  @Get()
  @ApiOperation({ summary: 'Whether two-factor is on' })
  @ApiOkResponse({ standardSchema: statusSchema })
  async status(@CurrentUser() user: UserPrincipal) {
    return {
      enabled: await this.mfa.isEnrolled(user.id),
      remainingRecoveryCodes: await this.mfa.remainingRecoveryCodes(user.id),
    };
  }

  // A stolen session must not put its own authenticator on the account (and lock its owner out).
  @Can.Anyone()
  @UserOnly()
  @RecentAuthentication()
  @Post('enroll')
  @RequiresSwitch('account.mfa', 'AUTH_MFA')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start setting up an authenticator app' })
  @ApiOkResponse({ standardSchema: enrollmentSchema })
  @ApiConflictResponse({
    description: 'Two-factor is already on: turn it off first.',
  })
  async enroll(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    verifiedEmailOnly(user);
    try {
      return await this.mfa.enroll(user.id, user.email);
    } catch (error) {
      if (error instanceof MfaAlreadyEnrolledError) {
        throw new ConflictException(t('account.mfaAlreadyOn'));
      }
      throw error;
    }
  }

  @Can.Anyone()
  @UserOnly()
  @Post('confirm')
  @RequiresSwitch('account.mfa', 'AUTH_MFA')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Turn two-factor on with a first code from the app',
    description:
      'Returns the recovery codes, once. This browser counts as verified.',
  })
  @ApiOkResponse({ standardSchema: recoveryCodesSchema })
  async confirm(
    @CurrentUser() user: UserPrincipal,
    @Body({ schema: codeSchema }) body: z.infer<typeof codeSchema>,
    @Ip() ip: string,
  ) {
    notWhileImpersonating(user);
    return {
      recoveryCodes: await this.account.enableMfa(user, body.code, ip),
    };
  }

  @Can.Anyone()
  @UserOnly({ mfa: true })
  @RecentAuthentication()
  @Post('recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: 'New recovery codes (the old ones stop working)' })
  @ApiOkResponse({ standardSchema: recoveryCodesSchema })
  async recoveryCodes(@CurrentUser() user: UserPrincipal) {
    notWhileImpersonating(user);
    return { recoveryCodes: await this.account.newRecoveryCodes(user) };
  }

  @Can.Anyone()
  @UserOnly({ mfa: true })
  @RecentAuthentication()
  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Turn two-factor off' })
  @ApiNoContentResponse()
  async disable(@CurrentUser() user: UserPrincipal, @Ip() ip: string) {
    notWhileImpersonating(user);
    await this.account.disableMfa(user, ip);
  }

  // The pending session of a sign-in: no user yet (its session is pending,
  // which @Public() reads without letting it act anywhere).
  // A wrong code is a failed sign-in for bot protection: counted on the
  // address and on the pending session's account, and challenged the same way.
  @Public()
  @Throttle({ default: { limit: 5, ttl: minutes(15) } })
  @Captcha({ action: 'sign-in', count: 'failures', account: 'session' })
  @Post('verify')
  @AllowInMaintenance()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Finish a sign-in with two-factor: a code from the app',
    description:
      'Or a recovery code (each works once). The pending session becomes a signed-in one, under a new id (the cookie changes). Wrong codes count towards a lockout.',
  })
  @ApiOkResponse({ standardSchema: signedInSchema })
  @ApiUnauthorizedResponse({
    description: 'No pending sign-in on this browser, or a wrong code.',
  })
  async verify(
    @Body({ schema: verifySchema }) body: z.infer<typeof verifySchema>,
  ) {
    if (!(await this.account.completeMfa(body))) {
      throw new UnauthorizedException(t('account.invalidCode'));
    }
    return { signedIn: true, mfaRequired: false };
  }
}
