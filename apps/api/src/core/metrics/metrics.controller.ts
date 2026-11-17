import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Res,
  UnauthorizedException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NodeResponse as Response } from '@nestjs/platform-node';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { metricsConfig } from './metrics.config.js';
import { MetricsService } from './metrics.service.js';

/** Equal strings, compared in constant time (their SHA-256, so lengths don't leak). */
const sameSecret = (given: string, expected: string) =>
  timingSafeEqual(
    createHash('sha256').update(given).digest(),
    createHash('sha256').update(expected).digest(),
  );

/**
 * `GET /metrics`: Prometheus' scrape. Off (404) unless METRICS_TOKEN is set;
 * then only with `Authorization: Bearer <METRICS_TOKEN>`. Scrape it from
 * inside the private network, never through the public proxy. Not an API
 * route: no version, not in the OpenAPI document, never cached. Not rate
 * limited, like /health: the limiter counts in Redis, so with Redis away
 * every scrape would hang until Prometheus gave up.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller({ path: 'metrics', version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @Inject(metricsConfig.KEY)
    private readonly config: ConfigType<typeof metricsConfig>,
  ) {}

  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    const { token } = this.config;
    if (!token) {
      throw new NotFoundException();
    }
    const given = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1] ?? '';
    if (!sameSecret(given, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      throw new UnauthorizedException('A valid metrics token is required.');
    }
    const { contentType, body } = await this.metrics.scrape();
    // Written as is, so the content type's parameters keep their order.
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }
}
