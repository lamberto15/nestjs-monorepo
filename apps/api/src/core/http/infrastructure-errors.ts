import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
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
 * in time. Clients and load balancers retry. A unique violation no service
 * mapped to its own code is a 409 `conflict`: two requests raced for the
 * same key, and the index decided (a service maps it where it can say more).
 * A value the database can't read as its column's type (bodies and queries
 * are validated first, so most often a malformed id in the path, but also
 * an enum, number or JSON text that got past validation) is a 400
 * `invalid_value`.
 */
export function infrastructureError(error: unknown) {
  switch (databaseErrorKind(error)) {
    case 'invalid_text':
      return new BadRequestException(
        {
          code: 'invalid_value',
          message: 'A value in the request is not valid for its field.',
        },
        { cause: error },
      );
    case 'unique_violation':
      return new ConflictException(
        {
          code: 'conflict',
          message: 'It conflicts with one that already exists.',
        },
        { cause: error },
      );
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
