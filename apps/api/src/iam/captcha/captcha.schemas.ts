import { z } from 'zod';

/** CaptchaService.settings(): what a page needs to render the widget. */
export const captchaSettingsSchema = z
  .object({
    provider: z.string().describe('`turnstile` (or `stub` in tests).'),
    siteKey: z.string().nullable().describe("The widget's public key."),
    mode: z
      .enum(['always', 'after-failures'])
      .describe(
        '`always`: render the widget up front. `after-failures`: only when a 403 `captcha_required` asks.',
      ),
  })
  .nullable()
  .describe('null: bot protection is off.');

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const attestationChallengeSchema = z.object({
  challenge: z
    .string()
    .describe(
      'One-time: bind one proof to it (App Attest: its SHA-256 as clientDataHash; Play Integrity: the nonce).',
    ),
  expiresIn: z.number().int().describe('Seconds until it expires.'),
});

export const appleKeySchema = z.object({
  keyId: base64url
    .max(64)
    .describe("App Attest's key id (`generateKey()`), base64url."),
  attestation: base64url
    .max(16_384)
    .describe("`attestKey()`'s attestation object, base64url."),
  challenge: base64url.max(64),
});

export const captchaSchema = z.object({ captcha: captchaSettingsSchema });
