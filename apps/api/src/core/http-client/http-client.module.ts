import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { HttpClientModule } from '@nestjs/http-client';
import { ResilienceModule } from '@nestjs/resilience';
import { observabilityConfig } from '../observability/observability.config.js';

/**
 * Calling other services. @nestjs/http-client: every client a module
 * registers (`HttpClientModule.register({ name, baseUrl })`) gets these
 * defaults: a user-agent, a 10s timeout, retries of idempotent requests.
 * @nestjs/resilience: its defaults, and the policies the services create
 * (`ResilienceService.create()`: timeouts, retries, circuit breakers).
 * For a URL a tenant gives the app, use `safeFetch` (core/http) instead.
 *
 * ORDER: ResilienceModule has a global interceptor that retries a route: list
 * this module after SharedIdempotencyModule and the usage module, so a
 * request is stored and metered once whatever the retries do.
 */
@Module({
  imports: [
    HttpClientModule.forRootAsync({
      imports: [ConfigModule.forFeature(observabilityConfig)],
      inject: [observabilityConfig.KEY],
      useFactory: (config: ConfigType<typeof observabilityConfig>) => ({
        headers: { 'user-agent': config.serviceName },
        timeout: '10s',
      }),
    }),
    ResilienceModule.forRoot({
      defaults: {
        timeout: '5s',
        retry: { attempts: 3, backoff: { delay: '200ms', maxDelay: '2s' } },
        circuitBreaker: {
          failureRateThreshold: 50,
          minimumCalls: 10,
          openDuration: '30s',
        },
      },
    }),
  ],
})
export class SharedHttpClientModule {}
