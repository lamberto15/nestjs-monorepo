import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../config/env.helpers.js';
import { readEnv } from '../config/env.js';

export const schema = z.object({
  /**
   * On SIGTERM, how long (ms) readiness answers 503 before the app closes,
   * so the load balancer stops sending requests first. Keep it above the
   * balancer's health-check interval times its unhealthy threshold.
   */
  SHUTDOWN_DRAIN_MS: integer(5000, { min: 0, max: 120_000 }),
});

export const healthConfig = registerAs('health', () => {
  const env = readEnv(schema);
  return { shutdownDrainMs: env.SHUTDOWN_DRAIN_MS };
});
