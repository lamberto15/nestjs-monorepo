import type { Pool, PoolClient } from 'pg';
import type { Mock } from 'vitest';
import { type DatabaseSink, observePool } from './database-observer.js';

function setup() {
  const query = vi.fn(async (_text: unknown) => ({ rows: [] }));
  const client = { query } as unknown as PoolClient;
  let acquire: () => Promise<PoolClient> = () => Promise.resolve(client);
  // As node-postgres' Pool: connect() is on the prototype.
  const pool = Object.create({
    connect: (...args: unknown[]) => {
      const callback = args[0] as
        ((error: unknown, client?: PoolClient) => void) | undefined;
      if (callback) {
        acquire().then(
          (c) => callback(undefined, c),
          (error: unknown) => callback(error),
        );
        return undefined;
      }
      return acquire();
    },
  }) as Pool;
  const sink = {
    acquired: vi.fn(),
    queried: vi.fn(),
    failed: vi.fn(),
    slow: vi.fn(),
  } satisfies Record<keyof DatabaseSink, Mock>;
  const stop = observePool(pool, sink);
  return {
    pool,
    sink,
    stop,
    query,
    failAcquire: (error: Error) => (acquire = () => Promise.reject(error)),
  };
}

describe('observePool', () => {
  it('times the wait for a connection and each statement, by its first word only', async () => {
    const { pool, sink, query } = setup();
    const client = await pool.connect();
    await client.query('  SELECT secret_column from t where x = $1');
    await client.query({ text: 'insert into t values (1)' });
    await client.query('vacuum');
    expect(sink.acquired).toHaveBeenCalledWith(expect.any(Number), 'success');
    expect(sink.queried.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ['select', 'success'],
      ['insert', 'success'],
      ['other', 'success'],
    ]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('times the callback form of connect() too, and wraps a client once', async () => {
    const { pool, sink, query } = setup();
    const client = await new Promise<PoolClient>((resolve) =>
      pool.connect((_error, c) => resolve(c!)),
    );
    await (await pool.connect()).query('select 1');
    expect(sink.acquired).toHaveBeenCalledTimes(2);
    // The same client checked out again is wrapped once: each statement counts once.
    expect(await pool.connect()).toBe(client);
    await client.query('select 1');
    expect(sink.queried).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('counts a connection refused for want of one as database_busy', async () => {
    const { pool, sink, failAcquire } = setup();
    failAcquire(new Error('timeout exceeded when trying to connect'));
    await expect(pool.connect()).rejects.toThrow('timeout exceeded');
    expect(sink.acquired).toHaveBeenCalledWith(expect.any(Number), 'error');
    expect(sink.failed).toHaveBeenCalledWith('database_busy');
  });

  it('counts a cancelled statement as database_timeout, and still throws it', async () => {
    const { pool, sink, query } = setup();
    query.mockRejectedValueOnce(
      Object.assign(new Error('canceling statement due to statement timeout'), {
        code: '57014',
      }),
    );
    const client = await pool.connect();
    await expect(client.query('select pg_sleep(9)')).rejects.toThrow('cancel');
    expect(sink.queried).toHaveBeenCalledWith(
      expect.any(Number),
      'select',
      'error',
    );
    expect(sink.failed).toHaveBeenCalledWith('database_timeout');
  });

  it('stops observing when undone', async () => {
    const { pool, sink, stop } = setup();
    stop();
    await pool.connect();
    expect(sink.acquired).not.toHaveBeenCalled();
  });
});
