import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { aiConfig } from './ai.config.js';
import { aiEnabled } from './ai.models.js';

/** `ai` of `GET /v1/features`: whether the helper has a provider, as a run checks it. */
@Feature({
  ai: z
    .boolean()
    .describe(
      'The AI helper has a provider (ANTHROPIC_API_KEY). Off: `POST /v1/ai/runs` answers 503 `ai_unavailable`. On, a tenant still opts in with its setting (403 `ai_disabled`).',
    ),
})
@Injectable()
export class AiFeature implements FeatureSwitch {
  constructor(
    @Inject(aiConfig.KEY)
    private readonly config: ConfigType<typeof aiConfig>,
  ) {}

  value() {
    return aiEnabled(this.config);
  }
}
