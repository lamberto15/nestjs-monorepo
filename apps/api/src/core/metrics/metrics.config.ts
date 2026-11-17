import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { optional, secret } from '../config/env.helpers.js';

export const schema = z.object({
  METRICS_TOKEN: secret(
    optional().pipe(z.string().min(16).optional()),
  ).describe(
    "Prometheus' bearer token for GET /metrics (at least 16 characters); unset, /metrics answers 404. Scrape from inside the private network.",
  ),
});

export const metricsConfig = registerAs('metrics', () => {
  const env = readEnv(schema);
  return { token: env.METRICS_TOKEN };
});
