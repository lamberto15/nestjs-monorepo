import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';
import { observabilityConfig } from '../../core/observability/observability.config.js';

export const schema = z.object({
  /** How long the download link a report's mail carries works, in hours (at most 7 days: the file is kept that long). */
  REPORT_LINK_TTL_HOURS: integer(24, { min: 1, max: 7 * 24 }),
});

export const reportsConfig = registerAs('reports', () => {
  const env = readEnv(schema);
  return {
    linkTtlHours: env.REPORT_LINK_TTL_HOURS,
    // SERVICE_NAME (core/observability): the report mails name it.
    serviceName: observabilityConfig().serviceName,
  };
});
