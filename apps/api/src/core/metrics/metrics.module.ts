import {
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { DatabasePoolMetrics } from './database-pool.metrics.js';
import { HttpMetricsMiddleware } from './http-metrics.middleware.js';
import { MetricsService } from './metrics.service.js';

/**
 * Metrics on the OpenTelemetry API, exported by the registered
 * MeterProvider (Nestrix's, over OTLP): requests in flight, calls to
 * deprecated routes, the database pool and its use. Global: a module
 * injects MetricsService and declares its own metrics.
 */
@Global()
@Module({
  providers: [MetricsService, DatabasePoolMetrics],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*path');
  }
}
