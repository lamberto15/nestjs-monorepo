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
    const failed = (code: 'database_busy' | 'database_timeout') => {
      this.metrics.databaseFailures.inc({ code });
      this.metrics.databaseLastFailure.set({ code }, Date.now() / 1000);
      this.metrics.databaseIncidents.inc({ trigger: code });
    };
    this.unobserve = observePool(pool, {
      acquired: (seconds, outcome) =>
        this.metrics.databaseAcquire.observe({ outcome }, seconds),
      queried: (seconds, operation, outcome) =>
        this.metrics.databaseQuery.observe({ operation, outcome }, seconds),
      failed,
      slow: () => this.metrics.databaseIncidents.inc({ trigger: 'slow_query' }),
    });
    this.metrics.collect(
      'db_pool_max_connections',
      'Configured application pool connection limit.',
      () => [{ value: pool.options.max ?? 10 }],
    );
    this.metrics.collect(
      'db_pool_connections',
      "This process's PostgreSQL pool: connections open (total), idle, and queries waiting for one.",
      () => [
        { labels: { state: 'total' }, value: pool.totalCount },
        { labels: { state: 'idle' }, value: pool.idleCount },
        { labels: { state: 'waiting' }, value: pool.waitingCount },
      ],
      ['state'],
    );
  }

  onModuleDestroy() {
    this.unobserve?.();
  }
}
