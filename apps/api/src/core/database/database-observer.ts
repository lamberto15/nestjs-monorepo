import type { Pool, PoolClient } from 'pg';
import { databaseErrorKind } from './database-errors.js';

/** What the pool's use told: the metrics subscribe (core/metrics/database-pool.metrics.ts). */
export interface DatabaseSink {
  acquired(seconds: number, outcome: 'success' | 'error'): void;
  queried(
    seconds: number,
    operation: string,
    outcome: 'success' | 'error',
  ): void;
  /** A refused or cancelled use: `database_busy` (no connection in time) or `database_timeout` (statement cancelled). */
  failed(code: 'database_busy' | 'database_timeout'): void;
  /** A statement that ran longer than SLOW_QUERY_MS. */
  slow(): void;
}

export const SLOW_QUERY_MS = 1000;

const OPERATIONS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'begin',
  'start',
  'commit',
  'rollback',
  'set',
  'show',
  'with',
]);

const operationOf = (query: unknown) => {
  const text =
    typeof query === 'string'
      ? query
      : (query as { text?: unknown } | null)?.text;
  const first =
    typeof text === 'string'
      ? /^\s*([a-z]+)/i.exec(text)?.[1]?.toLowerCase()
      : undefined;
  return first && OPERATIONS.has(first) ? first : 'other';
};

const secondsSince = (start: number) => (performance.now() - start) / 1000;

/**
 * Times the pool's use for the metrics: the wait for a connection and each
 * statement as the caller sees it (the pool's own wrapping of the tenant
 * scope included), and notes the failures an alert wants (no connection in
 * time, a statement cancelled). Wraps `connect()` on the pool instance, which
 * `pool.query()` and Drizzle's transactions both go through; each client's
 * `query()` is wrapped once. Nothing about a statement but its first word
 * leaves here, never its text or values. Returns what undoes it.
 */
export function observePool(pool: Pool, sink: DatabaseSink): () => void {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const wrapped = new WeakSet<PoolClient>();

  const failure = (error: unknown) => {
    const kind = databaseErrorKind(error);
    if (kind === 'pool_exhausted') sink.failed('database_busy');
    else if (kind === 'statement_timeout') sink.failed('database_timeout');
  };

  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const start = performance.now();
      const operation = operationOf(args[0]);
      const done = (error?: unknown) => {
        const seconds = secondsSince(start);
        sink.queried(seconds, operation, error ? 'error' : 'success');
        if (error) failure(error);
        if (seconds * 1000 > SLOW_QUERY_MS) sink.slow();
      };
      const last = args.at(-1);
      if (typeof last === 'function') {
        args[args.length - 1] = (error: unknown, ...rest: unknown[]) => {
          done(error);
          (last as (...a: unknown[]) => void)(error, ...rest);
        };
        return query(...args);
      }
      const result = query(...args);
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            done();
            return value;
          },
          (error: unknown) => {
            done(error);
            throw error;
          },
        );
      }
      return result;
    };
  };

  (pool as { connect: unknown }).connect = (...args: unknown[]) => {
    const start = performance.now();
    const callback = args[0];
    if (typeof callback === 'function') {
      return connect(
        (
          error: unknown,
          client: PoolClient | undefined,
          ...rest: unknown[]
        ) => {
          sink.acquired(secondsSince(start), error ? 'error' : 'success');
          if (error) failure(error);
          else if (client) instrument(client);
          (callback as (...a: unknown[]) => void)(error, client, ...rest);
        },
      );
    }
    return (connect() as Promise<PoolClient>).then(
      (client) => {
        sink.acquired(secondsSince(start), 'success');
        instrument(client);
        return client;
      },
      (error: unknown) => {
        sink.acquired(secondsSince(start), 'error');
        failure(error);
        throw error;
      },
    );
  };

  return () => {
    delete (pool as { connect?: unknown }).connect;
  };
}
