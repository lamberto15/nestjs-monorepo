import { z } from 'zod';
import { defineSettings, setting } from '../settings/settings.types.js';

/** A tenant's ceiling on an import's size (MiB): at most IMPORT_MAX_BYTES. */
export const IMPORT_MAX_MIB = setting({
  key: 'dataTransfer.importMaxMiB',
  label: 'Maximum import file size (MiB)',
  description: 'Maximum size of an uploaded import file.',
  schema: z
    .number()
    .int()
    .positive()
    .max(Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024))),
  default: 50,
});

/** A tenant's ceiling on an import's data rows: at most IMPORT_MAX_ROWS. */
export const IMPORT_MAX_ROWS = setting({
  key: 'dataTransfer.importMaxRows',
  label: 'Maximum import rows',
  description: 'Maximum number of data rows accepted in one import.',
  schema: z.number().int().positive(),
  default: 1_000_000,
});

export const DATA_TRANSFER_SETTINGS = defineSettings([
  IMPORT_MAX_MIB,
  IMPORT_MAX_ROWS,
]);
