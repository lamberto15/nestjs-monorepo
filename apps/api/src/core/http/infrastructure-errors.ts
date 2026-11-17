import { HttpException, HttpStatus } from '@nestjs/common';
import { databaseErrorKind } from '../database/database-errors.js';
import { queueUnavailable } from '../queues/queue-errors.js';

const overloaded = (code: string, message: string, cause: unknown) =>
  new HttpException(
    { message, code, retryAfter: 1 },
    HttpStatus.SERVICE_UNAVAILABLE,
    { cause },
  );

/**
 * The overload errors of the database and the queue as 503 problems with
 * Retry-After, not 500s: the request was fine, the service could not take it
 * in time. Clients and load balancers retry.
 */
export function infrastructureError(error: unknown) {
  switch (databaseErrorKind(error)) {
    case 'pool_exhausted':
      return overloaded(
        'database_busy',
        'The service is busy: try again shortly.',
        error,
      );
    case 'statement_timeout':
      return overloaded(
        'database_timeout',
        'The request took too long: try again, or narrow it (filters, a smaller page).',
        error,
      );
    default:
      return queueUnavailable(error);
  }
}
