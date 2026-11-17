import { randomUUID } from 'node:crypto';
import type { NodeRequest, NodeResponse } from '@nestjs/platform-node';

/** A request id accepted from the proxy or the client; anything else is replaced. */
export const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Gives every request an id (`X-Request-Id`: the proxy's or the client's
 * when it is safe to log, else a new UUID), on the request and in the
 * response. Applied with `app.use()` before the body parsers (http-setup.ts),
 * so a parser's error and a CSRF refusal carry it too; the problem details
 * answer it as `requestId`.
 */
export function assignRequestId(
  req: NodeRequest,
  res: NodeResponse,
  next: () => void,
) {
  ensureRequestId(req, res);
  next();
}

/** The request's id, given to it now if it has none yet. */
export function ensureRequestId(req: NodeRequest, res: NodeResponse) {
  const header = req.headers['x-request-id'];
  const requestId =
    typeof header === 'string' && REQUEST_ID.test(header)
      ? header
      : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('X-Request-Id', requestId);
  return requestId;
}
