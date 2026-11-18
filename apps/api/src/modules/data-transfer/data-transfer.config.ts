import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { integer, withDefault } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';
import { isTimeZone } from './zoned-time.js';

export const schema = z.object({
  /** The largest import file the deployment accepts, in bytes; the `dataTransfer.importMaxMiB` setting may only lower it. */
  IMPORT_MAX_BYTES: integer(50 * 1024 * 1024, { min: 1 }),
  /** The most data rows one import may hold; the `dataTransfer.importMaxRows` setting may only lower it. */
  IMPORT_MAX_ROWS: integer(1_000_000, { min: 1 }),
  /** The IANA time zone of a file's dates when neither the request nor the user names one. */
  TRANSFER_TIMEZONE: withDefault('UTC').refine(isTimeZone, {
    message: 'an IANA time zone, such as Europe/Berlin',
  }),
});

export const dataTransferConfig = registerAs('dataTransfer', () => {
  const env = readEnv(schema);
  return {
    maxBytes: env.IMPORT_MAX_BYTES,
    maxRows: env.IMPORT_MAX_ROWS,
    timezone: env.TRANSFER_TIMEZONE,
  };
});
