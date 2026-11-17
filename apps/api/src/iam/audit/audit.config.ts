import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** Audit entries older than this many days are deleted every night (03:15 UTC). */
  AUDIT_RETENTION_DAYS: integer(400, { min: 1 }),
});

export const auditConfig = registerAs('audit', () => {
  const env = readEnv(schema);
  return { retentionDays: env.AUDIT_RETENTION_DAYS };
});
