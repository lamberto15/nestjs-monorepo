import { Injectable, type NestMiddleware } from '@nestjs/common';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { matchedRouteKey } from '../http/route-key.js';
import { MetricsService } from './metrics.service.js';

/** Hands the request on, or an error to the error handlers (connect-style). */
type NextFunction = (error?: unknown) => void;

/** Not counted: the health checks (polled every few seconds). */
const UNMEASURED = /^\/health(\/|\?|$)/;

/**
 * Counts the requests being served, and the calls to a route marked
 * `@Deprecated()` (it sets the `Deprecation` header), labelled by the matched
 * route pattern, read at the response's `close` since routing comes after
 * middleware: `GET /v1/notes/{id}`, never the URL. Request durations are
 * Nestrix's (`http.server.request.duration`, by `http.route`), not timed
 * twice here.
 *
 * In flight is a number read at collection time, not an up-down counter: an
 * add on one provider and its matching subtract on the next (Nestrix's,
 * registered while a request runs) would leave the count off for good.
 *
 * A middleware, not an interceptor: interceptors don't see requests that
 * guards, pipes or a 404 stop first.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  private active = 0;

  constructor(private readonly metrics: MetricsService) {
    metrics.collect(
      'http.server.active_requests',
      'HTTP requests being served.',
      () => [{ value: this.active }],
      '{request}',
    );
  }

  use(req: Request, res: Response, next: NextFunction) {
    if (UNMEASURED.test(req.originalUrl ?? req.url ?? '')) {
      return next();
    }
    this.active++;
    res.once('close', () => {
      this.active--;
      if (res.hasHeader('Deprecation')) {
        const route = matchedRouteKey(req) ?? 'unmatched';
        this.metrics.deprecatedCalls.add(1, { route });
      }
    });
    next();
  }
}
