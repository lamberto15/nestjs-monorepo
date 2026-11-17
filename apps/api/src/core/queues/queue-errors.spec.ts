import { HttpException } from '@nestjs/common';
import { isQueueUnavailable, queueUnavailable } from './queue-errors.js';

describe('queue unavailable errors', () => {
  const offline = new Error(
    "Stream isn't writeable and enableOfflineQueue options is false",
  );

  it('recognises ioredis refusing a command on a down producer', () => {
    expect(isQueueUnavailable(offline)).toBe(true);
    const retries = new Error('Reached the max retries per request limit');
    retries.name = 'MaxRetriesPerRequestError';
    expect(isQueueUnavailable(retries)).toBe(true);
    expect(isQueueUnavailable(new Error('other', { cause: offline }))).toBe(
      true,
    );
    expect(isQueueUnavailable(new Error('boom'))).toBe(false);
  });

  it('answers 503 queue_unavailable with Retry-After instead of a 500', () => {
    const http = queueUnavailable(offline);
    expect(http).toBeInstanceOf(HttpException);
    expect(http?.getStatus()).toBe(503);
    expect(http?.getResponse()).toMatchObject({
      code: 'queue_unavailable',
      retryAfter: 2,
    });
    expect(queueUnavailable(new Error('boom'))).toBeUndefined();
  });
});
