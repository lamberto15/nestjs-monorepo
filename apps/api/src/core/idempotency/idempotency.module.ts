import { randomBytes } from 'node:crypto';
import { Inject, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { IdempotencyModule } from '@nestjs/idempotency';
import { openApiAdditions } from '../http/openapi.js';
import { Secrets } from '../secrets/secrets.service.js';
import { idempotencyConfig } from './idempotency.config.js';
import {
  applyIdempotencyMode,
  swaggerRequestInterceptor,
} from './idempotency.openapi.js';
import { callerScope } from './idempotency.scope.js';
import { DrizzleIdempotencyStore } from './idempotency.store.js';

/**
 * Idempotency-Key on the routes marked @IdempotentRoute(): a retry gets the
 * first response instead of running the handler again. Records are kept in
 * PostgreSQL (idempotency_keys).
 *
 * ORDER: its interceptor is global and must be the outermost, so list this
 * module before every module with a global interceptor (usage, then the
 * resilience of core/http-client): a replay passes through no other
 * interceptor, so it is neither metered nor held to a quota, and a 403 is
 * stored and replayed like any other 4xx. Guards run before every
 * interceptor, so the scope sees the caller.
 */
@Module({
  imports: [
    ConfigModule.forFeature(idempotencyConfig),
    IdempotencyModule.forRootAsync({
      imports: [ConfigModule.forFeature(idempotencyConfig)],
      inject: [idempotencyConfig.KEY, Secrets],
      useFactory: async (
        config: ConfigType<typeof idempotencyConfig>,
        secrets: Secrets,
      ) => ({
        required: config.required,
        scope: callerScope,
        ttl: '24h', // longer than any client keeps retrying
        lockTtl: '60s', // how long a crashed instance blocks a key
        retryAfter: '1s',
        // A 429 is not an outcome: a quota's ends with its period, and the retry must run then.
        storeIf: (status: number) => status < 500 && status !== 429,
        // Stored responses can hold a secret: seal them at rest.
        encryption: {
          keys:
            config.keys ??
            (
              await secrets.loadOrCreate('IDEMPOTENCY_KEYS', () =>
                randomBytes(32).toString('base64'),
              )
            ).split(','),
        },
      }),
    }),
  ],
  providers: [DrizzleIdempotencyStore],
})
export class SharedIdempotencyModule {
  constructor(
    @Inject(idempotencyConfig.KEY)
    config: ConfigType<typeof idempotencyConfig>,
  ) {
    // The published document follows IDEMPOTENCY, and Swagger UI makes a
    // key for "Try it out".
    openApiAdditions.document.set('idempotency', (document) =>
      applyIdempotencyMode(document, config.mode),
    );
    openApiAdditions.swaggerOptions.requestInterceptor =
      swaggerRequestInterceptor;
  }
}
