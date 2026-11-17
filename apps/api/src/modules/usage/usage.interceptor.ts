import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { matchedRouteKey } from '../../core/http/route-key.js';
import type { Principal } from '../../iam/auth/principal.js';
import { UsageCounters } from './usage.counters.js';
import { secondsToUtcMidnight } from './usage.keys.js';
import { UsageService } from './usage.service.js';
import { usageConfig } from './usage.config.js';

/** Routes that are never metered: health checks and the API docs. */
const UNMETERED = /^\/(health|api)(\/|$)/;

/**
 * Meters API clients: before the handler, a client over its daily quota gets
 * a 429 `quota_exceeded`; after the response, the request is counted per UTC
 * day and route. Users, guests, /health and /api are not counted.
 *
 * An interceptor, not a guard: it needs the principal, which the global
 * guards have set by then. @nestjs/throttler limits per time window; a
 * daily quota per client, counted per route, is not something it offers.
 * The quota is exact: a request takes its place in today's total on entry,
 * atomically (UsageCounters.take).
 */
@Injectable()
export class UsageInterceptor implements NestInterceptor {
  constructor(
    @Inject(usageConfig.KEY)
    private readonly config: ConfigType<typeof usageConfig>,
    private readonly usage: UsageService,
    private readonly counters: UsageCounters,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    if (!this.config.enabled || context.getType() !== 'http') {
      return next.handle();
    }
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: Principal | null }>();
    const res = http.getResponse<Response>();
    const principal = req.user;
    const route = matchedRouteKey(req);
    if (
      principal?.kind !== 'client' ||
      route === undefined ||
      UNMETERED.test(req.path)
    ) {
      return next.handle();
    }
    const quota = await this.usage.quotaOf(principal.id);
    if (quota !== null) {
      const { allowed, used } = await this.counters.take(principal, quota);
      res.setHeader('X-Quota-Limit', String(quota));
      if (!allowed) {
        const reset = secondsToUtcMidnight();
        res.setHeader('X-Quota-Remaining', '0');
        res.setHeader('X-Quota-Reset', String(reset));
        throw new HttpException(
          {
            code: 'quota_exceeded',
            message: t('usage.quotaExceeded', { args: { quota } }),
            // The problem filter sets Retry-After from it.
            retryAfter: reset,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (used !== null) {
        res.setHeader('X-Quota-Remaining', String(Math.max(0, quota - used)));
      }
    }
    // 'close', not 'finish': it also fires when the caller hangs up mid-response.
    res.once('close', () =>
      this.counters.count(principal, route, quota === null),
    );
    return next.handle();
  }
}
