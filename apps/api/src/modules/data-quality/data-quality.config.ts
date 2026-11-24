import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * Findings no scan or recheck has found again for this many days are
   * deleted every night, dismissed ones too: a scan already deletes what no
   * longer holds, so what is left this old is of record types no longer
   * scanned, or of a scan nobody ran again. The next scan finds what holds.
   */
  DATA_QUALITY_FINDING_RETENTION_DAYS: integer(180, { min: 1 }),
});

export const dataQualityConfig = registerAs('dataQuality', () => {
  const env = readEnv(schema);
  return { findingRetentionDays: env.DATA_QUALITY_FINDING_RETENTION_DAYS };
});
