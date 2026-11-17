import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { RequestLogMiddleware } from './request-log.middleware.js';

/**
 * Request ids and the request log line. The logger itself is built before the
 * app, in main.ts: `app.useLogger(createLogger())` (logging.ts).
 */
@Module({})
export class LoggingModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLogMiddleware).forRoutes('*path');
  }
}
