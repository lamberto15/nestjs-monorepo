import {
  applyQueueConcurrency,
  closeWhenRedisIsDown,
  DEFAULT_JOB_OPTIONS,
  queueConcurrencyVariable,
  workerConnection,
} from './queues.js';
import { consumesQueue } from './queues.config.js';
import { producerRedisOptions } from '../redis/redis.js';

const worker = (name: string, concurrency: number) => ({ name, concurrency });

describe('applyQueueConcurrency', () => {
  it('sets a worker from the variable named after its queue', () => {
    const data = worker('data-transfers', 2);
    const mail = worker('mail', 5);
    const values: Record<string, string> = {
      QUEUE_CONCURRENCY_DATA_TRANSFERS: '1',
      QUEUE_CONCURRENCY_MAIL: '8',
    };
    applyQueueConcurrency([data, mail], (key) => values[key]);
    expect(data.concurrency).toBe(1);
    expect(mail.concurrency).toBe(8);
  });

  it('keeps the processor value of a queue without a valid variable', () => {
    const other = worker('thumbnails', 3);
    applyQueueConcurrency([other], () => undefined);
    expect(other.concurrency).toBe(3);
    applyQueueConcurrency([other], () => '0');
    expect(other.concurrency).toBe(3);
  });

  it('names the variable after the queue', () => {
    expect(queueConcurrencyVariable('attachment-scan')).toBe(
      'QUEUE_CONCURRENCY_ATTACHMENT_SCAN',
    );
  });
});

describe('consumesQueue', () => {
  it('takes every queue when neither list is set', () => {
    expect(consumesQueue('mail', { only: [], exclude: [] })).toBe(true);
  });

  it('splits the queues between a light and a heavy worker', () => {
    const heavy = ['data-transfers', 'documents'];
    const light = { only: [], exclude: heavy };
    expect(consumesQueue('mail', light)).toBe(true);
    expect(consumesQueue('documents', light)).toBe(false);
    const only = { only: heavy, exclude: [] };
    expect(consumesQueue('data-transfers', only)).toBe(true);
    expect(consumesQueue('mail', only)).toBe(false);
  });
});

describe('worker connection', () => {
  it('takes the producer options back to waiting for Redis', () => {
    const producer = producerRedisOptions({
      url: 'redis://localhost:6379',
      password: undefined,
      sentinels: [],
      sentinelName: 'mymaster',
      prefix: 'app',
    });
    expect(producer.enableOfflineQueue).toBe(false);
    expect(workerConnection(producer as never)).toMatchObject({
      host: 'localhost',
      port: 6379,
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });
  });
});

describe('job defaults', () => {
  it('retry three times with exponential backoff', () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({
      type: 'exponential',
      delay: 1000,
    });
  });
});

describe('closing a producer queue with Redis down', () => {
  const offline = new Error(
    "Stream isn't writeable and enableOfflineQueue options is false",
  );

  it('drops the connection instead of failing the shutdown', async () => {
    const disconnect = vi.fn();
    const queue = {
      close: vi.fn().mockRejectedValue(offline),
      getBackend: () => ({
        connection: { client: Promise.resolve({ disconnect }) },
      }),
    };
    closeWhenRedisIsDown(queue as never);
    await expect(queue.close()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('passes on any other failure', async () => {
    const queue = {
      close: vi.fn().mockRejectedValue(new Error('boom')),
      getBackend: vi.fn(),
    };
    closeWhenRedisIsDown(queue as never);
    await expect(queue.close()).rejects.toThrow('boom');
  });
});
