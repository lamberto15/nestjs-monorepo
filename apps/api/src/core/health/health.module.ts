import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';

@Module({
  imports: [TerminusModule, DiscoveryModule],
  controllers: [HealthController],
})
export class HealthModule {}
