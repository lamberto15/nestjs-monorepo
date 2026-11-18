import {
  Inject,
  Injectable,
  Logger,
  type ExecutionContext,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { throttlingConfig } from './throttling.config.js';

/**
 * ThrottlerGuard with every limit multiplied by RATE_LIMIT_MULTIPLIER (1
 * unless set): the load test raises the limits rather than turning them off,
 * so the guard still runs, and costs, what it costs in production.
 *
 * Custom: @nestjs/throttler resolves a function `limit` for the module's
 * throttlers, but a route's `@Throttle({ limit: 5 })` replaces it with a
 * plain number; scaling the resolved limit in handleRequest covers both.
 */
@Injectable()
export class ScaledThrottlerGuard extends ThrottlerGuard {
  protected readonly multiplier: number;

  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    @Inject(throttlingConfig.KEY)
    config: ConfigType<typeof throttlingConfig>,
  ) {
    super(options, storageService, reflector);
    this.multiplier = config.multiplier;
    if (this.multiplier !== 1) {
      new Logger('Throttler').warn(
        `RATE_LIMIT_MULTIPLIER=${this.multiplier}: every rate limit is ${this.multiplier} times higher (load tests only).`,
      );
    }
  }

  /**
   * Only HTTP requests are counted. Nest runs global guards on other
   * contexts too (an MCP tool call, a socket message), where there is no
   * request and so no address: every caller would share one counter. Such a
   * call arrived in an HTTP request or a connection that was counted.
   */
  protected override async shouldSkip(context: ExecutionContext) {
    return context.getType() !== 'http' || (await super.shouldSkip(context));
  }

  /** The limit after RATE_LIMIT_MULTIPLIER. */
  protected scaled(limit: number) {
    return limit * this.multiplier;
  }

  protected override handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    return super.handleRequest({
      ...requestProps,
      limit: this.scaled(requestProps.limit),
    });
  }
}
