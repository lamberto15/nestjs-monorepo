import { z } from 'zod';
import { defineEvent } from '../../core/outbox/events.js';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';
import type { TransferJob, TransferResult } from './data-transfer.types.js';

/**
 * A transfer that ended: completed with its result, or failed for good with
 * a reason for people. Published on the worker in its tenant, in the
 * transaction of its audit entry; whoever started one in code (a scheduled
 * report, by its `tag`) subscribes with `@OnDomainEvent()`.
 */
export type TransferFinished =
  | {
      id: string;
      job: TransferJob;
      status: 'completed';
      result: TransferResult;
    }
  | { id: string; job: TransferJob; status: 'failed'; error: string };

export const transferFinished = defineEvent<TransferFinished>(
  'data.transfer-finished',
);

const transfer = { id: z.string(), name: z.string() };
const kind = z.enum(['export', 'import']);

/** To whoever started the export: the file is ready; `url` is a signed link. */
export const dataExportReady = defineRealtimeEvent(
  'data.export-ready',
  z.object({ ...transfer, rows: z.int(), url: z.string() }),
  'An export is ready: url is a signed link to the file.',
);

/** To whoever started the import: how many rows went in and how many were refused. */
export const dataImportFinished = defineRealtimeEvent(
  'data.import-finished',
  z.object({
    ...transfer,
    rows: z.int(),
    imported: z.int(),
    failed: z.int(),
  }),
  'An import ended: how many rows were imported and how many refused.',
);

/** An export at most once a second, an import every PROGRESS_EVERY rows. */
export const dataProgress = defineRealtimeEvent(
  'data.progress',
  z.object({
    ...transfer,
    kind,
    processed: z.int(),
    imported: z.int().optional(),
    failed: z.int().optional(),
  }),
  'An export or import is running: processed rows so far (an import also imported and failed). Throttled; GET /v1/data/transfers/{id} has the same numbers.',
);

/** A transfer failed for good (not a few refused rows: that is data.import-finished). */
export const dataFailed = defineRealtimeEvent(
  'data.failed',
  z.object({ ...transfer, kind, error: z.string() }),
  'An export or import failed for good; error says why, for people. The transfer reads failed at GET /v1/data/transfers/{id} by now.',
);
