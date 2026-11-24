import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { healthConfig } from './health.config.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    // On SIGTERM readiness turns 503 for the drain time, then the app closes.
    TerminusModule.forRootAsync({
      imports: [ConfigModule.forFeature(healthConfig)],
      inject: [healthConfig.KEY],
      useFactory: (config: ConfigType<typeof healthConfig>) => ({
        gracefulShutdownTimeoutMs: config.shutdownDrainMs,
      }),
    }),
    DiscoveryModule,
  ],
  controllers: [HealthController],
})
export class HealthModule {}
