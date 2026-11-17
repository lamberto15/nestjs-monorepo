import { Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  Feature,
  type FeatureSwitch,
  type FeatureValue,
} from '../../core/http/feature.js';

/**
 * Which switches this deployment has on, for a client that hides what is
 * off: the values of every provider marked `@Feature(name)`. Custom code: no
 * @nestjs package reports an app's own switches.
 */
@Injectable()
export class FeaturesService {
  constructor(private readonly discovery: DiscoveryService) {}

  current(): Record<string, FeatureValue> {
    const features: Record<string, FeatureValue> = {};
    for (const wrapper of this.discovery.getProviders({
      metadataKey: Feature.KEY,
    })) {
      const name = this.discovery.getMetadataByDecorator(Feature, wrapper);
      if (name && wrapper.instance) {
        features[name] = (wrapper.instance as FeatureSwitch).value();
      }
    }
    return features;
  }
}
