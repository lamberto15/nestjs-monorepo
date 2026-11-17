import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { FeaturesController } from './features.controller.js';
import { FeaturesService } from './features.service.js';

/**
 * `GET /v1/features`: the deployment's switches, as the modules that own
 * them report (`@Feature()`). A tenant's feature flags are settings
 * (modules/settings), not this.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [FeaturesController],
  providers: [FeaturesService],
})
export class FeaturesModule {}
