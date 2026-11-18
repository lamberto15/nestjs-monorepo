import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  type ChoiceProvider,
  ChoicesRegistry,
  ChoiceSets,
  ChoiceSource,
} from './choices.registry.js';

/**
 * Fills the registry at startup from what modules declare: their
 * `@ChoiceSource()` providers, then their sets (so a set finds its
 * providers whatever the module order).
 */
@Injectable()
export class ChoicesLoader implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly registry: ChoicesRegistry,
  ) {}

  onModuleInit() {
    for (const wrapper of this.discovery.getProviders({
      metadataKey: ChoiceSource.KEY,
    })) {
      if (wrapper.instance) {
        this.registry.provider(wrapper.instance as ChoiceProvider);
      }
    }
    const declared = new Set<ChoiceSets>();
    for (const wrapper of this.discovery.getProviders()) {
      if (wrapper.instance instanceof ChoiceSets)
        declared.add(wrapper.instance);
    }
    for (const { sets } of declared) {
      for (const set of sets) this.registry.set(set);
    }
  }
}
