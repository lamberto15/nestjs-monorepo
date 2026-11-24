import { EventEmitter } from 'node:events';
import { MailEvents } from '@nestjs/mail';
import { Subject } from 'rxjs';
import { OPS_STREAM_MAX_MS, OpsEventStream, opsEvent } from './ops.events.js';

describe('opsEvent', () => {
  it('tags the source, reduces an error to a masked message and keeps no stack', () => {
    const event = opsEvent(
      'mail',
      {
        type: 'failed',
        messageId: 'm1',
        recipients: ['a@example.com'],
        subject: 'Hello',
        transport: 'smtp',
        attempts: 2,
        durationMs: 12.5,
        permanent: false,
        error: new Error('refused: password=hunter2'),
      },
      1000,
    );
    expect(event).toMatchObject({ source: 'mail', at: 1000, type: 'failed' });
    expect(JSON.stringify(event)).not.toContain('hunter2');
    expect(JSON.stringify(event)).not.toContain('at Object');
  });

  it('never carries a payload or a header, whatever the engine sent', () => {
    const event = opsEvent('outbox', {
      type: 'published',
      transport: 'bullmq',
      durationMs: 3,
      message: {
        id: 'o1',
        topic: 'x',
        key: null,
        createdAt: 1,
        availableAt: 1,
        attempts: 0,
        lastError: null,
        headers: { authorization: 'Bearer abc' },
        payload: { email: 'person@example.com' },
      },
    });
    expect(event).toBeDefined();
    expect(JSON.stringify(event)).not.toContain('person@example.com');
    expect(JSON.stringify(event)).not.toContain('Bearer');
  });

  it('leaves out an event the schema does not know, instead of failing', () => {
    expect(opsEvent('workflow', { type: 'something-new' })).toBeUndefined();
  });

  it("keeps the resilience policy's own source as origin", () => {
    expect(
      opsEvent('resilience', {
        type: 'timeout',
        policy: 'p',
        source: 'http',
        timeoutMs: 5,
      }),
    ).toMatchObject({ source: 'resilience', origin: 'http' });
  });
});

describe('OpsEventStream', () => {
  /** One Redis server in memory: what `publish` sends, every subscribed duplicate receives. */
  function fakeRedis() {
    const subscribers = new Set<EventEmitter>();
    const redis = {
      options: {},
      publish: vi.fn(async (_channel: string, message: string) => {
        for (const subscriber of subscribers)
          subscriber.emit('message', _channel, message);
        return subscribers.size;
      }),
      duplicate: () => {
        const subscriber = Object.assign(new EventEmitter(), {
          subscribe: async () => {
            subscribers.add(subscriber);
          },
          quit: async () => {
            subscribers.delete(subscriber);
            return 'OK';
          },
          disconnect: () => subscribers.delete(subscriber),
          status: 'ready',
        });
        return subscriber;
      },
    };
    return { redis, subscribers };
  }

  function instance(redis: unknown) {
    const engine = { events$: new Subject<object>() };
    const modules = {
      get: (token: unknown) => {
        if (token === MailEvents) return engine;
        throw new Error('absent');
      },
    };
    const stream = new OpsEventStream(modules as never, redis as never);
    stream.onModuleInit();
    return { stream, engine };
  }

  const mailEvent = {
    type: 'sent',
    messageId: 'm1',
    recipients: ['a@example.com'],
    subject: 'Hello',
    transport: 'smtp',
    attempts: 1,
    durationMs: 1,
  };

  it("shows another instance's events, and stops publishing while nobody watches", async () => {
    const { redis } = fakeRedis();
    const api = instance(redis);
    const worker = instance(redis);

    worker.engine.events$.next(mailEvent);
    await vi.waitFor(() => expect(redis.publish).toHaveBeenCalledTimes(1));
    worker.engine.events$.next(mailEvent);
    expect(redis.publish).toHaveBeenCalledTimes(1);

    const seen: unknown[] = [];
    const subscription = api.stream
      .stream()
      .subscribe((event) => seen.push(event));
    // The quiet time is over.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
    worker.engine.events$.next(mailEvent);
    await vi.waitFor(() =>
      expect(seen).toEqual([
        expect.objectContaining({ source: 'mail', type: 'sent' }),
      ]),
    );
    subscription.unsubscribe();
    vi.restoreAllMocks();
  });

  it('ends open streams before the server closes, and after OPS_STREAM_MAX_MS', async () => {
    const { redis, subscribers } = fakeRedis();
    const { stream } = instance(redis);
    const completed = vi.fn();
    stream.stream().subscribe({ complete: completed });
    await vi.waitFor(() => expect(subscribers.size).toBe(1));
    stream.beforeApplicationShutdown();
    expect(completed).toHaveBeenCalled();
    await vi.waitFor(() => expect(subscribers.size).toBe(0));

    vi.useFakeTimers();
    const timedOut = vi.fn();
    stream.stream().subscribe({ complete: timedOut });
    vi.advanceTimersByTime(OPS_STREAM_MAX_MS);
    expect(timedOut).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
