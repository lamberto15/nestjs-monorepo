import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Days between a person asking for their account's deletion and the nightly job carrying it out; they may cancel until then. */
  ACCOUNT_DELETION_GRACE_DAYS: integer(14, { min: 0, max: 365 }),
});

export const personalDataConfig = registerAs('personalData', () => {
  const env = readEnv(schema);
  return { deletionGraceDays: env.ACCOUNT_DELETION_GRACE_DAYS };
});
