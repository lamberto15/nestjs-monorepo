import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiForbiddenResponse, ApiHeader } from '@nestjs/swagger';

/** The header the widget's token travels in. */
export const CAPTCHA_HEADER = 'X-Captcha-Token';
/** The header a native app's proof travels in, in place of `X-Captcha-Token`. */
export const ATTESTATION_HEADER = 'X-App-Attestation';

export interface CaptchaOptions {
  /** The widget's `data-action` on the page that calls this route: a token minted for another is refused. */
  action: string;
  /**
   * What `after-failures` counts here: `failures` (an answer that is a 4xx:
   * a wrong password, an unknown account) or `requests` (every request: a
   * route that always answers 202 so as to reveal nothing).
   */
  count: 'failures' | 'requests';
}

/** The route metadata CaptchaGuard reads. */
export const CAPTCHA = Symbol('captcha');

/**
 * Asks for bot protection on a public route (sign-in, sign-up, the
 * magic-link request, forgot password, the verification resend): with
 * CAPTCHA_MODE on, it wants a challenge token in `X-Captcha-Token`, always
 * or after N failed attempts from the address or for the account. Only
 * metadata, with no import of the captcha module: CaptchaModule's global
 * guard reads it, and a route is simply not checked where that module isn't
 * installed. Documented in OpenAPI as a header, so the bodies and the
 * generated client stay as they are.
 *
 * Custom: @nestjs/throttler limits how often, not who; the global throttle
 * stays in front of the guard, so a flood is refused before any token is
 * verified.
 */
export const Captcha = (options: CaptchaOptions) =>
  applyDecorators(
    SetMetadata(CAPTCHA, options),
    ApiHeader({
      name: CAPTCHA_HEADER,
      required: false,
      description: `The challenge token (Cloudflare Turnstile, widget action \`${options.action}\`), when GET /auth/captcha lists a captcha: always, or once a 403 \`captcha_required\` asked for one.`,
      schema: { type: 'string' },
    }),
    ApiHeader({
      name: ATTESTATION_HEADER,
      required: false,
      description:
        "A native app's proof instead (APP_ATTESTATION): `ios <challenge> <keyId> <assertion>` (App Attest) or `android <challenge> <token>` (Play Integrity), the challenge from POST /auth/app-attestation/challenge.",
      schema: { type: 'string' },
    }),
    ApiForbiddenResponse({
      description:
        '`captcha_required`: solve the challenge (the problem names `provider`, `siteKey` and `action`) and send its token in `X-Captcha-Token`. `captcha_invalid`: the token was refused (`reason`: `invalid`, `duplicate`, `hostname`, `action`); render the widget again. `attestation_invalid`: the `X-App-Attestation` proof was refused (`reason`). Provider down: 503 `captcha_unavailable` (fail-closed), or 429 `rate_limited` past the fail-open allowance.',
    }),
  );
