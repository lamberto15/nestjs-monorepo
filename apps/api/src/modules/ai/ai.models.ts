import { createAnthropic } from '@ai-sdk/anthropic';
import type { AiModuleOptions } from '@nestjs/ai';
import type { ConfigType } from '@nestjs/config';
import { declareSecrets } from '../../core/logging/redaction.js';
import type { aiConfig } from './ai.config.js';

// A prompt holds a record's personal data: never in a log line or an error report.
declareSecrets({ fields: ['prompt', 'systemPrompt', 'completion'] });

type AiConfig = ConfigType<typeof aiConfig>;

/** The helper is on while an API key is set; unset, nothing is ever sent anywhere (503 `ai_unavailable`). */
export const aiEnabled = (config: AiConfig) => Boolean(config.apiKey);

/**
 * The models of `AiModule` (@nestjs/ai): `default` and `cheap` on the
 * Anthropic API through @ai-sdk/anthropic, pinned by AI_MODEL and
 * AI_MODEL_CHEAP. The package's own retries are off and every attempt is
 * limited by AI_TIMEOUT_MS: the queue retries a whole run (AI_ATTEMPTS), so
 * the work is never paid for twice by two layers. The provider reads the key
 * when a call is made, so an unset key only fails a call, which the service
 * never makes while `aiEnabled()` is false.
 */
export function aiModuleOptions(config: AiConfig): AiModuleOptions {
  const anthropic = createAnthropic({
    apiKey: config.apiKey,
    // The provider's base URL ends in /v1; AI_BASE_URL has always been the host.
    baseURL: config.baseUrl ? `${config.baseUrl}/v1` : undefined,
  });
  return {
    models: {
      default: anthropic(config.model),
      cheap: anthropic(config.cheapModel),
    },
    defaults: { retry: false, timeout: config.timeoutMs },
  };
}
