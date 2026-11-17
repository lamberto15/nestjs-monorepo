import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';

/** A comma-separated list of keys, newest first; unset is an empty list. */
const keys = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((key) => key.trim())
      .filter(Boolean),
  );

export const schema = z.object({
  /** Data keys: `openssl rand -base64 32` each. The first encrypts, all decrypt. */
  DATA_ENCRYPTION_KEYS: keys,
  /** Blind-index keys, the same way; never a key also in DATA_ENCRYPTION_KEYS. */
  BLIND_INDEX_KEYS: keys,
});

export const encryptionConfig = registerAs('encryption', () => {
  const env = readEnv(schema);
  return {
    dataKeys: env.DATA_ENCRYPTION_KEYS,
    indexKeys: env.BLIND_INDEX_KEYS,
  };
});
