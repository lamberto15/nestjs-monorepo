import { Injectable } from '@nestjs/common';
import { Feature, type FeatureSwitch } from '../../core/http/feature.js';
import { ModeService } from './mode.service.js';

/** `mode` in `GET /v1/features`, for a client to show a banner. */
@Feature('mode')
@Injectable()
export class ModeFeature implements FeatureSwitch {
  constructor(private readonly mode: ModeService) {}

  value() {
    return this.mode.current();
  }
}
