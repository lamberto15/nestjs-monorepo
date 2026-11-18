import { z } from 'zod';
import { defineRealtimeEvent } from '../realtime/realtime.events.js';

const document = {
  id: z.uuid(),
  subject: z.string(),
  recordId: z.uuid(),
};

/** The requester's document is issued: download it at GET /v1/documents/{id}/download, or as the record's attachment. */
export const documentReady = defineRealtimeEvent(
  'document.ready',
  z.object({ ...document, attachmentId: z.uuid() }),
  "A document you asked for was issued: download it at GET /v1/documents/{id}/download, or as the record's attachment.",
);

/** The requester's document failed for good; `error` is the code of documents.errors. */
export const documentFailed = defineRealtimeEvent(
  'document.failed',
  z.object({ ...document, error: z.string() }),
  'A document you asked for failed for good; error is its code.',
);
