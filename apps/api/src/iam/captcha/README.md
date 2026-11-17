# iam/captcha

Bot protection for public routes, and app attestation for native apps.

## Ask for it on a route

```ts
@Public()
@Captcha({ action: 'sign-in', count: 'failures' })
@Post('sign-in')
```

`Captcha` (`captcha.decorator.ts`) is only metadata plus OpenAPI docs and imports nothing of this module. CaptchaModule's global guard reads it; without the module installed a route is simply not checked. List the module after ThrottlingModule and AuthModule. `count`: `failures` (a 4xx answer counts for `after-failures`) or `requests` (a route that always answers 202). The account an attempt names is the body's `email`.

Refusals: 403 `captcha_required` (names `provider`, `siteKey`, `action`), 403 `captcha_invalid` (`reason`), 503 `captcha_unavailable` (CAPTCHA_ON_ERROR=reject), 429 `rate_limited` (fail-open allowance used). A route that gives an attempt back itself calls `CaptchaService.release({ ip, email })`.

`GET /auth/captcha` tells a page the provider, site key and mode (null: off). With APP_ATTESTATION on, `POST /auth/app-attestation/challenge` and `/keys` serve native apps, whose `X-App-Attestation` replaces the token (iOS App Attest, Android Play Integrity).

## Variables (captcha.config.ts)

CAPTCHA_MODE, CAPTCHA_PROVIDER (`turnstile`, or the `stub` of tests, refused in production), TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, CAPTCHA_VERIFY_URL, CAPTCHA_HOSTNAMES, CAPTCHA_TIMEOUT_MS, CAPTCHA_ON_ERROR, CAPTCHA_FAILURES, CAPTCHA_FAILURES_WINDOW_MINUTES, CAPTCHA_DEGRADED_LIMIT, APP_ATTESTATION, APP_ATTESTATION_APPLE_APPS, APP_ATTESTATION_ANDROID_APPS, APP_ATTEST_DEVELOPMENT, PLAY_INTEGRITY_DECRYPTION_KEY, PLAY_INTEGRITY_VERIFICATION_KEY.

## Tests

Specs next to the code; e2e files per mode (`captcha`, `captcha-after-failures`, `captcha-outage`, `app-attestation`), using `captcha-stand-in.ts` (a siteverify stand-in and a probe controller).

Remove: delete this folder, its line in `app.module.ts` and the `app_attest_keys` table (a new migration).
