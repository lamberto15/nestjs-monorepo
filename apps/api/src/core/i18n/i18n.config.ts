import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';

/**
 * The languages the app ships texts for: English. To add one, give every
 * module's `i18n` folder a `<locale>.json` and name it in LOCALES.
 */
const SHIPPED_LOCALES = ['en'];

export const schema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  /**
   * The languages this deployment enables, comma separated; the first is the
   * default. Shipped: en.
   */
  LOCALES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((locale) => locale.trim())
        .filter(Boolean),
    )
    .transform((locales) => (locales.length > 0 ? locales : SHIPPED_LOCALES)),
});

export const i18nConfig = registerAs('i18n', () => {
  const env = readEnv(schema);
  return {
    locales: env.LOCALES,
    // A missing key is a bug: fail loudly in development and tests, fall back in production.
    missingKey:
      env.NODE_ENV === 'production'
        ? ('fallback' as const)
        : ('throw' as const),
  };
});
