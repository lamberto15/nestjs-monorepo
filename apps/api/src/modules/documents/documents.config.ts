import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { baseUrl, integer } from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /**
   * Gotenberg (https://gotenberg.dev), the service that renders the PDF
   * (Chromium in its own container). Unset, documents are off: asking for
   * one is a 503 `documents_unavailable`; nothing else needs it.
   */
  GOTENBERG_URL: baseUrl(),
  /** One render's limit, in milliseconds; a render that takes longer is tried again. */
  GOTENBERG_TIMEOUT_MS: integer(30_000, { min: 100 }),
  /** Tries per document, the first included (exponential backoff from 1 s), before it fails. */
  DOCUMENTS_RENDER_ATTEMPTS: integer(3, { min: 1, max: 10 }),
});

export const documentsConfig = registerAs('documents', () => {
  const env = readEnv(schema);
  return {
    gotenbergUrl: env.GOTENBERG_URL,
    timeoutMs: env.GOTENBERG_TIMEOUT_MS,
    renderAttempts: env.DOCUMENTS_RENDER_ATTEMPTS,
  };
});
