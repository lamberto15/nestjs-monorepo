import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { Pool } from 'pg';
import type { Database } from '../database/database.js';
import { observePool } from '../database/database-observer.js';
import { MetricsService } from './metrics.service.js';

/**
 * The database pool's connections, read from the pool Drizzle holds
 * (`$client`). Optional: an app without the database module has no pool and
 * no gauge.
 */
@Injectable()
export class DatabasePoolMetrics implements OnModuleInit, OnModuleDestroy {
  private unobserve?: () => void;

  constructor(
    private readonly metrics: MetricsService,
    @Optional() @InjectDrizzle() private readonly db?: Database,
  ) {}

  onModuleInit() {
    // Drizzle's node-postgres database keeps its pool as `$client` (not in its type).
    const pool = (this.db as { $client?: unknown } | undefined)?.$client;
    if (!(pool instanceof Pool)) {
      return;
    }
    // A counter's first sample can already be 1. A timestamp also shows a
    // failure from before the backend's first collection.
    const lastFailure = { database_busy: 0, database_timeout: 0 };
    const failed = (code: 'database_busy' | 'database_timeout') => {
      this.metrics.databaseFailures.add(1, { code });
      lastFailure[code] = Date.now() / 1000;
      this.metrics.databaseIncidents.add(1, { trigger: code });
    };
    this.unobserve = observePool(pool, {
      acquired: (seconds, outcome) =>
        this.metrics.databaseAcquire.record(seconds, { outcome }),
      queried: (seconds, operation, outcome) =>
        this.metrics.databaseQuery.record(seconds, { operation, outcome }),
      failed,
      slow: () =>
        this.metrics.databaseIncidents.add(1, { trigger: 'slow_query' }),
    });
    this.metrics.collect(
      'db_last_failure_timestamp_seconds',
      'Unix timestamp of the last database failure, including before the first collection.',
      () =>
        Object.entries(lastFailure).map(([code, value]) => ({
          labels: { code },
          value,
        })),
      's',
    );
    this.metrics.collect(
      'db_pool_max_connections',
      'Configured application pool connection limit.',
      () => [{ value: pool.options.max ?? 10 }],
      '{connection}',
    );
    this.metrics.collect(
      'db_pool_connections',
      "This process's PostgreSQL pool: connections open (total), idle, and queries waiting for one.",
      () => [
        { labels: { state: 'total' }, value: pool.totalCount },
        { labels: { state: 'idle' }, value: pool.idleCount },
        { labels: { state: 'waiting' }, value: pool.waitingCount },
      ],
      '{connection}',
    );
  }

  onModuleDestroy() {
    this.unobserve?.();
  }
}
