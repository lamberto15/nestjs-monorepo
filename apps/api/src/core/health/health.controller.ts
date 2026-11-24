import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { Public } from '@nestjs/authentication';
import { SkipThrottle } from '@nestjs/throttler';
import { AllowInMaintenance } from '../http/maintenance.js';
import { ReadinessCheck, type ReadinessIndicator } from './readiness.js';

/**
 * For load balancers and orchestrators:
 *
 * - `GET /health/ready` (readiness; `GET /health` is the same check): 200
 *   when every `@ReadinessCheck()` of the app answers, 503 when one doesn't
 *   or while the app shuts down.
 * - `GET /health/live` (liveness): 200 while the process serves requests,
 *   draining included.
 */
// Probes are never rate limited.
@Public()
@SkipThrottle()
@AllowInMaintenance()
@ApiExcludeController()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly discovery: DiscoveryService,
  ) {}

  @Get(['', 'ready'])
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

  /**
   * Not through Terminus: its graceful shutdown answers every check 503
   * while the app drains, and a failing liveness probe means "restart me",
   * which a draining process doesn't want. Terminus's body, with no checks.
   */
  @Get('live')
  live() {
    return { status: 'ok', info: {}, error: {}, details: {} };
  }
}
