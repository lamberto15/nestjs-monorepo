import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, minutes } from '@nestjs/throttler';
import type { z } from 'zod';
import {
  appleKeySchema,
  attestationChallengeSchema,
} from './captcha.schemas.js';
import { AppAttestationService } from './app-attestation.service.js';

/**
 * App attestation (APP_ATTESTATION):
 * the challenges a native app binds its proofs to, and an iOS install's
 * App Attest key. 404 while off.
 */
@ApiTags('auth')
@Public()
@Controller('auth/app-attestation')
export class AppAttestationController {
  constructor(private readonly attestation: AppAttestationService) {}

  @Throttle({ default: { limit: 30, ttl: minutes(1) } })
  @Post('challenge')
  @HttpCode(200)
  @ApiOperation({ summary: 'A one-time challenge for an app attestation' })
  @ApiOkResponse({ standardSchema: attestationChallengeSchema })
  @ApiNotFoundResponse({ description: 'App attestation is off.' })
  challenge() {
    return this.attestation.challenge();
  }

  @Throttle({ default: { limit: 10, ttl: minutes(15) } })
  @Post('keys')
  @HttpCode(204)
  @ApiOperation({
    summary: "Register an iOS install's App Attest key",
    description:
      'Once per key, with an attestation made over a challenge: Apple vouches that the key belongs to a genuine build of an app of APP_ATTESTATION_APPLE_APPS. Its assertions then go in `X-App-Attestation`.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({
    description:
      '`attestation_invalid` (`reason`: `challenge`, `format`, `certificate`, `nonce`, `key`, `app`, `authenticator`).',
  })
  @ApiNotFoundResponse({ description: 'App attestation is off.' })
  async register(
    @Body({ schema: appleKeySchema }) body: z.infer<typeof appleKeySchema>,
  ) {
    await this.attestation.registerAppleKey(body);
  }
}
