import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import {
  type HttpClient,
  getHttpClientToken,
  HttpClientModule,
} from '@nestjs/http-client';
import { httpConfig } from '../../core/http/http.config.js';
import { SharedHttpClientModule } from '../../core/http-client/http-client.module.js';
import {
  APP_ATTEST_ROOTS,
  AppAttestationService,
} from './app-attestation.service.js';
import { APPLE_APP_ATTESTATION_ROOT } from './app-attestation.js';
import { AppAttestationController } from './app-attestation.controller.js';
import { CAPTCHA_VERIFIER } from './captcha-verifier.js';
import { captchaConfig } from './captcha.config.js';
import { CaptchaController } from './captcha.controller.js';
import { CaptchaGuard } from './captcha.guard.js';
import { createCaptchaVerifier, verifyEndpoint } from './captcha.providers.js';
import { CaptchaRepository } from './captcha.repository.js';
import { CaptchaService } from './captcha.service.js';
import { TURNSTILE_HTTP } from './turnstile.verifier.js';

/**
 * Bot protection (README.md): a global guard that checks the routes marked
 * `@Captcha()` (captcha.decorator.ts), the verifier CAPTCHA_PROVIDER names,
 * and app attestation for native apps. List it after ThrottlingModule and
 * AuthModule (the guards' order); it needs MetricsModule, RedisModule and
 * DatabaseModule.
 */
@Module({
  imports: [
    ConfigModule.forFeature(captchaConfig),
    ConfigModule.forFeature(httpConfig),
    SharedHttpClientModule,
    // The siteverify endpoint: the timeout and breaker come from CaptchaService.
    HttpClientModule.registerAsync({
      name: TURNSTILE_HTTP,
      imports: [ConfigModule.forFeature(captchaConfig)],
      inject: [captchaConfig.KEY],
      useFactory: (config: ConfigType<typeof captchaConfig>) => ({
        baseUrl: verifyEndpoint(config.verifyUrl).baseUrl,
        timeout: config.timeoutMs,
        retry: false,
      }),
    }),
  ],
  controllers: [CaptchaController, AppAttestationController],
  providers: [
    {
      provide: CAPTCHA_VERIFIER,
      inject: [captchaConfig.KEY, getHttpClientToken(TURNSTILE_HTTP)],
      useFactory: (
        config: ConfigType<typeof captchaConfig>,
        http: HttpClient,
      ) => createCaptchaVerifier(config, http),
    },
    CaptchaService,
    AppAttestationService,
    CaptchaRepository,
    { provide: APP_ATTEST_ROOTS, useValue: [APPLE_APP_ATTESTATION_ROOT] },
    CaptchaGuard,
    { provide: APP_GUARD, useExisting: CaptchaGuard },
  ],
  exports: [CaptchaService],
})
export class CaptchaModule {}
