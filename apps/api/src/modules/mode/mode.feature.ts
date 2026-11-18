import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { ModeService } from './mode.service.js';

/** `mode` in `GET /v1/features`, for a client to show a banner. */
@Feature({
  mode: z
    .enum(['normal', 'read-only', 'maintenance'])
    .describe(
      "`APP_MODE` or the operators' setting. `read-only`: writes answer 503 `read_only`. `maintenance`: everything but health, sign-in and the operators' routes answers 503 `maintenance`.",
    ),
})
@Injectable()
export class ModeFeature implements FeatureSwitch {
  constructor(private readonly mode: ModeService) {}

  value() {
    return this.mode.current();
  }
}
