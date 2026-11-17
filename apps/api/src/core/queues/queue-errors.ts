import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Whether `error` is ioredis refusing a command because the producer
 * connection is down: no offline queue ("Stream isn't writeable and
 * enableOfflineQueue options is false"), or the retries ran out
 * (MaxRetriesPerRequestError). The chain of causes is searched.
 */
export function isQueueUnavailable(error: unknown) {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const { name, message } = e as { name?: unknown; message?: unknown };
    if (
      name === 'MaxRetriesPerRequestError' ||
      (typeof message === 'string' &&
        message.includes('enableOfflineQueue options is false'))
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * An enqueue refused while Redis is unreachable is a 503 `queue_unavailable`
 * with Retry-After, not a 500 reported as a bug: the request was fine, the
 * queue could not take it. Returns that exception for such an error, else
 * undefined: the HTTP error filter calls it before it answers a 500.
 */
export function queueUnavailable(error: unknown) {
  return isQueueUnavailable(error)
    ? new HttpException(
        {
          message: 'The service is busy: try again shortly.',
          code: 'queue_unavailable',
          retryAfter: 2,
        },
        HttpStatus.SERVICE_UNAVAILABLE,
        { cause: error },
      )
    : undefined;
}
