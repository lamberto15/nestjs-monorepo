import {
  Controller,
  Get,
  Module,
  Param,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { getDrizzleToken } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { recordMetrics } from '../../../test/metrics.js';
import type { Database } from '../database/database.js';
import { DatabaseModule } from '../database/database.module.js';
import { Deprecated } from '../http/deprecated.js';
import { MetricsModule } from './metrics.module.js';

@Controller({ path: 'probe', version: VERSION_NEUTRAL })
class ProbeController {
  @Get()
  list() {
    return [];
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return { id };
  }

  @Get('old/route')
  @Deprecated({ since: '2026-01-01' })
  old() {
    return {};
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('metrics (e2e)', () => {
  let app: NestNodeApplication;
  let recorded: ReturnType<typeof recordMetrics>;

  beforeAll(async () => {
    recorded = recordMetrics();
    app = await bootModules(DatabaseModule, MetricsModule, ProbeModule);
  });
  afterAll(async () => {
    await app.close();
    await recorded.stop();
  });

  /** A histogram point's count. */
  const count = (point: { value: unknown } | undefined) =>
    (point?.value as { count: number } | undefined)?.count ?? 0;

  it('reports the pool, the heap limit and nothing in flight', async () => {
    expect(await recorded.read('http.server.active_requests')).toEqual([
      { attributes: {}, value: 0 },
    ]);
    const pool = await recorded.read('db_pool_connections');
    expect(pool.map((point) => point.attributes.state)).toEqual(
      expect.arrayContaining(['idle', 'total', 'waiting']),
    );
    const [max] = await recorded.read('db_pool_max_connections');
    expect(max!.value).toBeGreaterThan(0);
    const [heap] = await recorded.read('nodejs_heap_size_limit_bytes');
    expect(heap!.value).toBeGreaterThan(0);
  });

  it('times the database: connection waits, statements by operation, and the failures at 0', async () => {
    // The probe reads nothing, so ask the database something.
    await app.get<Database>(getDrizzleToken()).execute(sql`select 1`);
    const acquired = await recorded.read(
      'db_connection_acquire_duration_seconds',
    );
    expect(
      count(acquired.find((p) => p.attributes.outcome === 'success')),
    ).toBeGreaterThan(0);
    const queried = await recorded.read('db_query_duration_seconds');
    expect(
      count(
        queried.find(
          (p) =>
            p.attributes.operation === 'select' &&
            p.attributes.outcome === 'success',
        ),
      ),
    ).toBeGreaterThan(0);
    expect(await recorded.read('db_failures')).toEqual(
      expect.arrayContaining([
        { attributes: { code: 'database_busy' }, value: 0 },
        { attributes: { code: 'database_timeout' }, value: 0 },
      ]),
    );
    expect(await recorded.read('db_last_failure_timestamp_seconds')).toEqual(
      expect.arrayContaining([
        { attributes: { code: 'database_busy' }, value: 0 },
      ]),
    );
    expect(await recorded.read('db_incidents')).toContainEqual({
      attributes: { trigger: 'slow_query' },
      value: 0,
    });
  });

  it('counts a cancelled statement: the failure, its timestamp and the incident', async () => {
    const db = app.get<Database>(getDrizzleToken());
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = 50`);
        await tx.execute(sql`select pg_sleep(2)`);
      }),
    ).rejects.toThrow();
    expect(await recorded.read('db_failures')).toContainEqual({
      attributes: { code: 'database_timeout' },
      value: 1,
    });
    expect(await recorded.read('db_incidents')).toContainEqual({
      attributes: { trigger: 'database_timeout' },
      value: 1,
    });
    const last = await recorded.read('db_last_failure_timestamp_seconds');
    const timeout = last.find((p) => p.attributes.code === 'database_timeout');
    expect(timeout!.value).toBeGreaterThan(1e9);
  });

  it('counts the calls to a deprecated route, by route pattern', async () => {
    await app.inject({ method: 'GET', url: '/probe/old/route' });
    await app.inject({ method: 'GET', url: '/probe/old/route' });
    await app.inject({ method: 'GET', url: '/probe/abc123-secret-id' });
    expect(await recorded.read('deprecated_route_calls')).toEqual([
      { attributes: { route: 'GET /probe/old/route' }, value: 2 },
    ]);
  });

  it('serves no /metrics route: metrics go out over OTLP', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });
});
