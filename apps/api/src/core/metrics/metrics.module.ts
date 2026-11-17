import {
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabasePoolMetrics } from './database-pool.metrics.js';
import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { MetricsController } from './metrics.controller.js';
import { metricsConfig } from './metrics.config.js';
import { MetricsService } from './metrics.service.js';

/**
 * Prometheus metrics at `GET /metrics` (METRICS_TOKEN): HTTP durations by
 * route pattern, requests in flight, the database pool, Node's defaults.
 * Global: a module injects MetricsService and declares its own metrics.
 */
@Global()
@Module({
  imports: [ConfigModule.forFeature(metricsConfig)],
  controllers: [MetricsController],
  providers: [MetricsService, DatabasePoolMetrics],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*path');
  }
}
