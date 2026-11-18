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
