import { Controller, Get } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';

/**
 * For load balancers and orchestrators:
 *
 * - `GET /health` (readiness): 200 when PostgreSQL answers, 503 when it
 *   doesn't or while the app shuts down.
 * - `GET /health/live` (liveness): 200 while the process serves requests.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    @InjectDrizzle() private readonly db: Database,
  ) {}

  @Get()
  @HealthCheck()
  ready() {
    return this.health.check([
      () =>
        this.indicator
          .check('database')
          // A ping has no query-builder form.
          .attempt(async () => {
            await this.db.execute(sql`select 1`);
          })
          .withTimeout(2000),
    ]);
  }

  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }
}
