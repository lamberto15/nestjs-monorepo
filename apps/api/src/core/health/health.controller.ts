import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { ReadinessCheck, type ReadinessIndicator } from './readiness.js';

/**
 * For load balancers and orchestrators:
 *
 * - `GET /health` (readiness): 200 when every `@ReadinessCheck()` of the
 *   app answers, 503 when one doesn't or while the app shuts down.
 * - `GET /health/live` (liveness): 200 while the process serves requests.
 */
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly discovery: DiscoveryService,
  ) {}

  @Get()
  @HealthCheck()
  ready() {
    const checks = this.discovery
      .getProviders({ metadataKey: ReadinessCheck.KEY })
      .map((provider) => ({
        name: this.discovery.getMetadataByDecorator(ReadinessCheck, provider)!,
        indicator: provider.instance as ReadinessIndicator,
      }));
    return this.health.check(
      checks.map(
        ({ name, indicator }) =>
          () =>
            this.indicator
              .check(name)
              .attempt(() => indicator.check())
              .withTimeout(2000),
      ),
    );
  }

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }
}
