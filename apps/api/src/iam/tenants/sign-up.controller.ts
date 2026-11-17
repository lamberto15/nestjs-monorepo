import { Body, Controller, Ip, Post } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { minutes } from '@nestjs/throttler';
import { z } from 'zod';
import { AddressThrottle } from '../auth/address-throttle.guard.js';
import { Captcha } from '../captcha/captcha.decorator.js';
import { SignUpService } from './sign-up.service.js';

const signUpSchema = z.object({
  email: z.string().trim().pipe(z.email()).meta({ example: 'ada@example.com' }),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(12).max(128),
  locale: z.string().min(2).max(35).optional(),
  timezone: z.string().min(1).max(64).optional(),
  tenantName: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe(
      'With TENANT_SIGN_UP: the name of the tenant you make (your name without one).',
    ),
});

const signedUpSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  tenantId: z
    .uuid()
    .nullable()
    .describe('The tenant it joined (TENANCY=single), else null.'),
});

/** Self sign-up (AUTH_SIGN_UP). */
@ApiTags('auth')
@Controller('auth')
export class SignUpController {
  constructor(private readonly signUps: SignUpService) {}

  // Five per address and email every 15 minutes, and bot protection.
  @Public()
  @AddressThrottle({
    name: 'sign-up',
    limit: 5,
    ttl: minutes(15),
    perEmail: true,
  })
  @Captcha({ action: 'sign-up', count: 'requests' })
  @Post('sign-up')
  @ApiOperation({
    summary:
      'Create an account (AUTH_SIGN_UP=on); it signs in once its address is verified',
    description:
      'Verify first: no session is made, and the password signs in only after the address is proved. The account has no tenant (a tenant invites it); with TENANCY=single it joins the one tenant; with TENANT_SIGN_UP it makes a tenant (`tenantName`) and is its administrator.',
  })
  @ApiCreatedResponse({ standardSchema: signedUpSchema })
  @ApiForbiddenResponse({ description: '`sign_up_closed`: AUTH_SIGN_UP=off.' })
  @ApiConflictResponse({
    description: '`email_taken`: an account with this address exists.',
  })
  async signUp(
    @Body({ schema: signUpSchema }) body: z.infer<typeof signUpSchema>,
    @Ip() ip: string,
  ) {
    const user = await this.signUps.signUp(
      {
        email: body.email,
        name: body.name,
        password: body.password,
        locale: body.locale ?? null,
        timezone: body.timezone ?? null,
        tenantName: body.tenantName,
      },
      ip,
    );
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      tenantId: user.tenantId,
    };
  }
}
