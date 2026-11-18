import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  choice,
  flag,
  integer,
  list,
  optional,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

/** What a file may be, recognized from its bytes (the types an upload may declare). */
const DEFAULT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
];

export const schema = z.object({
  /** The largest attachment, in MB (413 `payload_too_large` past it). */
  ATTACHMENT_MAX_MB: integer(25, { min: 1, max: 5000 }),
  /**
   * The types an attachment may be, comma-separated, recognized from the
   * file's bytes (415 otherwise). Empty: images, PDF, Office documents,
   * text, CSV and zip.
   */
  ATTACHMENT_ALLOWED_TYPES: list(),
  /**
   * Malware scanning of uploads. `off`: files are served as soon as they are
   * stored. `clamav`: a queue job streams each upload to clamd
   * (CLAMAV_HOST); it is `pending` (not downloadable) until clean, and an
   * infected file is deleted. `memory`: a test double that flags the EICAR
   * test string.
   */
  MALWARE_SCANNER: choice(['off', 'clamav', 'memory'], 'off'),
  /** clamd's host; required with MALWARE_SCANNER=clamav. */
  CLAMAV_HOST: optional(),
  CLAMAV_PORT: integer(3310, { min: 1, max: 65535 }),
  /** How long clamd may take to answer one scan, in milliseconds. */
  CLAMAV_TIMEOUT_MS: integer(60_000, { min: 1000 }),
  /** Attempts of a queued scan (exponential backoff from 5 s) before the retry job takes over. */
  MALWARE_SCAN_ATTEMPTS: integer(5, { min: 1, max: 10 }),
  /**
   * `on`: uploaded JPEG, PNG, WebP and GIF images get a thumbnail and a
   * preview, and an original carrying metadata is replaced by a copy
   * without it (modules/images). `off`: images are stored as uploaded.
   */
  IMAGE_PROCESSING: flag('on'),
  /**
   * `on`: the global search also finds files by what they say (the text of
   * plain text, CSV, PDF and DOCX uploads is extracted on a worker).
   */
  ATTACHMENT_TEXT_SEARCH: flag('off'),
  /** The largest file whose text is extracted, in MB (a larger one is stored `failed`). */
  ATTACHMENT_TEXT_MAX_MB: integer(20, { min: 1, max: 500 }),
  /** How long one extraction may run, in milliseconds, before its thread is stopped. */
  ATTACHMENT_TEXT_TIMEOUT_MS: integer(30_000, { min: 1000 }),
});

export const attachmentsConfig = registerAs('attachments', () => {
  const env = readEnv(schema);
  return {
    maxBytes: env.ATTACHMENT_MAX_MB * 1024 * 1024,
    maxMb: env.ATTACHMENT_MAX_MB,
    types: env.ATTACHMENT_ALLOWED_TYPES.length
      ? env.ATTACHMENT_ALLOWED_TYPES
      : DEFAULT_TYPES,
    malwareScanner: env.MALWARE_SCANNER,
    clamav: {
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
      timeoutMs: env.CLAMAV_TIMEOUT_MS,
    },
    scanAttempts: env.MALWARE_SCAN_ATTEMPTS,
    imageProcessing: env.IMAGE_PROCESSING,
    textSearch: env.ATTACHMENT_TEXT_SEARCH,
    textMaxBytes: env.ATTACHMENT_TEXT_MAX_MB * 1024 * 1024,
    textTimeoutMs: env.ATTACHMENT_TEXT_TIMEOUT_MS,
  };
});
