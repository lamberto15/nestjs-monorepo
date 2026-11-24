import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import {
  baseUrl,
  integer,
  optional,
  secret,
  withDefault,
} from '../../core/config/env.helpers.js';
import { readEnv } from '../../core/config/env.js';

export const schema = z.object({
  /** The Anthropic API key. Unset, the AI helper is off: nothing is ever sent anywhere (503 `ai_unavailable`). */
  ANTHROPIC_API_KEY: secret(optional()),
  /** The host of an Anthropic-compatible endpoint (`/v1` is added); unset: Anthropic's. */
  AI_BASE_URL: baseUrl(),
  /** The model of the `default` tier: a pinned id, never `latest`. */
  AI_MODEL: withDefault('claude-sonnet-5-5'),
  /** The model of the `cheap` tier (short, simple tasks): a pinned id. */
  AI_MODEL_CHEAP: withDefault('claude-haiku-5-5'),
  /** Milliseconds one attempt of a model call may take (at most two minutes: the worker's lock is three). */
  AI_TIMEOUT_MS: integer(60_000, { min: 1000, max: 120_000 }),
  /** The most tokens a model may answer with. */
  AI_MAX_OUTPUT_TOKENS: integer(1024, { min: 64, max: 8192 }),
  /** Tries of a run the queue makes in all (a transient provider failure is retried). */
  AI_ATTEMPTS: integer(2, { min: 1, max: 5 }),
  /** Seconds an identical prompt is answered from Redis; 0: never. */
  AI_CACHE_TTL_SECONDS: integer(3600, { min: 0 }),
  /**
   * Ended runs older than this many days are deleted every night. A run is
   * the usage record (who asked, the model, the tokens): kept as long as
   * the audit log (AUDIT_RETENTION_DAYS), for a year's comparison of usage.
   */
  AI_RUN_RETENTION_DAYS: integer(400, { min: 1 }),
});

export const aiConfig = registerAs('ai', () => {
  const env = readEnv(schema);
  return {
    apiKey: env.ANTHROPIC_API_KEY,
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL,
    cheapModel: env.AI_MODEL_CHEAP,
    timeoutMs: env.AI_TIMEOUT_MS,
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS,
    attempts: env.AI_ATTEMPTS,
    cacheTtlSeconds: env.AI_CACHE_TTL_SECONDS,
    runRetentionDays: env.AI_RUN_RETENTION_DAYS,
  };
});
