import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type {
  NodeRequest as Request,
  NodeResponse as Response,
} from '@nestjs/platform-node';
import { ensureRequestId } from '../http/request-id.js';

/**
 * Gives each request an id (`X-Request-Id`: the proxy's or the client's when
 * it is safe, otherwise a new one), returns it in the response, and logs one
 * line per request when it ends: method, path, status, duration, caller and
 * request id. Error responses read the id from the request's header.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: (error?: unknown) => void) {
    const requestId = ensureRequestId(req, res);

    const started = process.hrtime.bigint();
    // Read now: by `finish` a closed connection has no socket left to read it from.
    const ip = req.ip;
    res.on('finish', () => {
      const path = req.originalUrl.split('?')[0];
      if (path.startsWith('/health')) {
        return;
      }
      const fields = {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        ip,
      };
      const message = `${req.method} ${path} ${res.statusCode}`;
      // 503 says "overloaded, retry": a warning, not an error alert.
      if (res.statusCode >= 500 && res.statusCode !== 503) {
        this.logger.error(message, fields);
      } else if (res.statusCode >= 400) {
        this.logger.warn(message, fields);
      } else {
        this.logger.log(message, fields);
      }
    });
    next();
  }
}
