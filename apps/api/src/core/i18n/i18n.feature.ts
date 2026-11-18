import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { Feature, type FeatureSwitch } from '../http/feature.js';
import { i18nConfig } from './i18n.config.js';

/** `locales` of `GET /v1/features`: the languages a client may offer. */
@Feature({
  locales: z
    .array(z.string())
    .describe(
      'The languages the API answers in (LOCALES); the first is the default.',
    ),
})
@Injectable()
export class LocalesFeature implements FeatureSwitch {
  constructor(
    @Inject(i18nConfig.KEY)
    private readonly config: ConfigType<typeof i18nConfig>,
  ) {}

  value() {
    return this.config.locales;
  }
}
