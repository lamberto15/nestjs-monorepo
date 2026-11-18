import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { z } from 'zod';
import { Feature, type FeatureSwitch } from '../http/feature.js';
import { tenancyConfig } from './tenancy.config.js';

/** `tenancy` of `GET /v1/features`: whether a client offers more than one tenant. */
@Feature({
  tenancy: z
    .enum(['multi', 'single'])
    .describe('`single`: the first tenant is the only one (TENANCY).'),
})
@Injectable()
export class TenancyFeature implements FeatureSwitch {
  constructor(
    @Inject(tenancyConfig.KEY)
    private readonly config: ConfigType<typeof tenancyConfig>,
  ) {}

  value() {
    return this.config.mode;
  }
}
