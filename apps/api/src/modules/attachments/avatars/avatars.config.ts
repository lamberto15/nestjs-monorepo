import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../../core/config/env.helpers.js';
import { readEnv } from '../../../core/config/env.js';

export const schema = z.object({
  /** The largest picture a user may set (PUT /v1/account/avatar), in MB: 413 past it. */
  AVATAR_MAX_MB: integer(2, { min: 1, max: 50 }),
});

export const avatarsConfig = registerAs('avatars', () => {
  const env = readEnv(schema);
  return {
    maxBytes: env.AVATAR_MAX_MB * 1024 * 1024,
    maxMb: env.AVATAR_MAX_MB,
  };
});
