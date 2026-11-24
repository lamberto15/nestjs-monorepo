import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Ip,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Public, SignInService } from '@nestjs/authentication';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { Captcha } from '../captcha/captcha.decorator.js';
import { PasswordSignInThrottle } from './address-throttle.guard.js';
import { DuringMfaEnrollment } from './mfa-enrollment.guard.js';
import { DuringOnboarding } from './onboarding.js';
import { PasswordSignIn } from './password-sign-in.service.js';
import { WithoutSso } from './sign-in-gate.js';

/** An email address; spaces around it (a paste) are dropped first. */
const email = z
  .string()
  .trim()
  .pipe(z.email())
  .meta({ example: 'admin@example.com' });

const signInSchema = z.object({
  email,
  password: z.string().min(1).max(256),
});

const signedInSchema = z.object({
  signedIn: z.boolean(),
  mfaRequired: z
    .boolean()
    .describe(
      'true: the second factor is still to come before the session counts as signed in.',
    ),
});

/** Signing in and out of a browser session. */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly passwords: PasswordSignIn,
    private readonly signInService: SignInService,
  ) {}

  @Public()
  @PasswordSignInThrottle()
  @Captcha({ action: 'sign-in', count: 'failures' })
  @Post('sign-in')
  @AllowInMaintenance()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Sign in with a password: sets the session cookie',
    description:
      'A session ends after SESSION_MAX_HOURS, or SESSION_IDLE_MINUTES without a request. An unknown email and a wrong password get the same answer. With two-factor on, the answer says mfaRequired.',
  })
  @ApiOkResponse({ standardSchema: signedInSchema })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password.' })
  signIn(
    @Body({ schema: signInSchema }) body: z.infer<typeof signInSchema>,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.passwords.signIn(body.email, body.password, { ip, userAgent });
  }

  @Public()
  @DuringMfaEnrollment()
  @DuringOnboarding()
  @WithoutSso()
  @Post('sign-out')
  @AllowInMaintenance()
  @HttpCode(204)
  @ApiOperation({ summary: "Sign out: ends this browser's session" })
  @ApiNoContentResponse()
  @ApiUnauthorizedResponse({ description: 'No session.' })
  async signOut() {
    if (!(await this.signInService.signOut())) {
      throw new UnauthorizedException();
    }
  }
}
