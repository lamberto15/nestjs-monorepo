import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { choice, optional, secret } from '../config/env.helpers.js';

export const schema = z.object({
  /**
   * `required`: the routes marked @IdempotentRoute() refuse a request without
   * an Idempotency-Key (400). `optional`: a key is honoured when sent, never demanded.
   */
  IDEMPOTENCY: choice(['required', 'optional'], 'required'),
  /** Seal stored idempotent responses: base64 keys, newest first. Unset: created once, kept in the database. */
  IDEMPOTENCY_KEYS: secret(optional()),
});

export const idempotencyConfig = registerAs('idempotency', () => {
  const env = readEnv(schema);
  return {
    required: env.IDEMPOTENCY === 'required',
    mode: env.IDEMPOTENCY,
    keys: env.IDEMPOTENCY_KEYS?.split(',').map((key) => key.trim()),
  };
});
