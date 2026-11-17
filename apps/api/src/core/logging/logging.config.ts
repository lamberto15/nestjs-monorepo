import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  /** The lowest level written; Nest's names, from most to least talkative. */
  LOG_LEVEL: z
    .enum(['verbose', 'debug', 'log', 'warn', 'error', 'fatal'])
    .default('log'),
  /** One JSON object per line, or readable text. Defaults to JSON in production. */
  LOG_FORMAT: z.enum(['json', 'text']).optional(),
  NODE_ENV: z.string().optional(),
});

export const loggingConfig = registerAs('logging', () => {
  const env = readEnv(schema);
  return {
    level: env.LOG_LEVEL,
    json:
      (env.LOG_FORMAT ?? (env.NODE_ENV === 'production' ? 'json' : 'text')) ===
      'json',
  };
});
