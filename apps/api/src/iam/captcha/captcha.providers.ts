import type { HttpClient } from '@nestjs/http-client';
import type { CaptchaConfig } from './captcha.config.js';
import { TURNSTILE_VERIFY_URL } from './captcha.config.js';
import type { CaptchaVerifier } from './captcha-verifier.js';
import { StubCaptchaVerifier } from './stub.verifier.js';
import { TurnstileVerifier } from './turnstile.verifier.js';

/** The siteverify URL split for @nestjs/http-client: its origin, and the path to post to. */
export function verifyEndpoint(url: string | undefined) {
  const parsed = new URL(url ?? TURNSTILE_VERIFY_URL);
  return { baseUrl: parsed.origin, path: parsed.pathname };
}

/**
 * The verifier CAPTCHA_PROVIDER names (captchaSettings() already refused the
 * combinations that must not start). `http` is the client registered on
 * CAPTCHA_VERIFY_URL's origin.
 */
export function createCaptchaVerifier(
  config: Pick<
    CaptchaConfig,
    'provider' | 'verifyUrl' | 'siteKey' | 'secretKey'
  >,
  http: HttpClient,
): CaptchaVerifier {
  if (config.provider === 'stub') {
    return new StubCaptchaVerifier();
  }
  return new TurnstileVerifier(
    http,
    verifyEndpoint(config.verifyUrl).path,
    config.secretKey ?? '',
    config.siteKey ?? '',
  );
}
