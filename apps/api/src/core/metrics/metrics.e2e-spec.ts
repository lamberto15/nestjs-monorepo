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
import type { Database } from '../database/database.js';
import { DatabaseModule } from '../database/database.module.js';
import { Deprecated } from '../http/deprecated.js';
import { MetricsModule } from './metrics.module.js';

const TOKEN = 'metrics-token-for-the-e2e-tests';

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

describe('GET /metrics (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    vi.stubEnv('METRICS_TOKEN', TOKEN);
    app = await bootModules(DatabaseModule, MetricsModule, ProbeModule);
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const scrape = (authorization: string | undefined = `Bearer ${TOKEN}`) =>
    app.inject({
      method: 'GET',
      url: '/metrics',
      headers: authorization ? { authorization } : {},
    });

  it('refuses a scrape without the token, or with a wrong one', async () => {
    const missing = await scrape('');
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toMatch(/^Bearer/);
    expect((await scrape(`Bearer ${TOKEN}x`)).statusCode).toBe(401);
    expect((await scrape(TOKEN)).statusCode).toBe(401);
  });

  it('serves the Prometheus exposition, never cached', async () => {
    const res = await scrape();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe(
      'text/plain; version=0.0.4; charset=utf-8',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toContain('process_cpu_seconds_total');
    // Only this scrape is in flight (the scrape itself is not measured).
    expect(res.body).toMatch(/^http_requests_in_flight 0$/m);
    expect(res.body).toMatch(/^db_pool_connections\{state="total"\} \d+$/m);
    expect(res.body).toMatch(/^db_pool_connections\{state="waiting"\} \d+$/m);
    expect(res.body).toMatch(/^db_pool_max_connections \d+$/m);
    expect(res.body).toMatch(/^nodejs_heap_size_limit_bytes \d+$/m);
  });

  it('times the database: connection waits, statements by operation, and the failures at 0', async () => {
    // The probe reads nothing, so ask the database something.
    await app.get<Database>(getDrizzleToken()).execute(sql`select 1`);
    const { body } = await scrape();
    expect(body).toMatch(
      /^db_connection_acquire_duration_seconds_count\{outcome="success"\} [1-9]\d*$/m,
    );
    expect(body).toMatch(
      /^db_query_duration_seconds_count\{operation="select",outcome="success"\} [1-9]\d*$/m,
    );
    expect(body).toMatch(/^db_failures_total\{code="database_busy"\} 0$/m);
    expect(body).toMatch(/^db_failures_total\{code="database_timeout"\} 0$/m);
    expect(body).toMatch(
      /^db_last_failure_timestamp_seconds\{code="database_busy"\} 0$/m,
    );
    expect(body).toMatch(/^db_incidents_total\{trigger="slow_query"\} 0$/m);
  });

  it('counts a cancelled statement: the failure, its timestamp and the incident', async () => {
    const db = app.get<Database>(getDrizzleToken());
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = 50`);
        await tx.execute(sql`select pg_sleep(2)`);
      }),
    ).rejects.toThrow();
    const { body } = await scrape();
    expect(body).toMatch(/^db_failures_total\{code="database_timeout"\} 1$/m);
    expect(body).toMatch(
      /^db_incidents_total\{trigger="database_timeout"\} 1$/m,
    );
    expect(body).toMatch(
      /^db_last_failure_timestamp_seconds\{code="database_timeout"\} 1\d{9}/m,
    );
  });

  it('times requests by route pattern, never by URL', async () => {
    await app.inject({ method: 'GET', url: '/probe' });
    await app.inject({ method: 'GET', url: '/probe/abc123-secret-id' });
    await app.inject({ method: 'GET', url: '/no-such-route' });
    await app.inject({ method: 'GET', url: '/health' });

    const { body } = await scrape();
    expect(body).toContain(
      'http_request_duration_seconds_bucket{le="0.005",method="GET",route="GET /probe",status="200"}',
    );
    expect(body).toMatch(
      /^http_request_duration_seconds_count\{method="GET",route="GET \/probe\/\{id\}",status="200"\} 1$/m,
    );
    expect(body).toContain('route="unmatched",status="404"');
    expect(body).not.toContain('abc123-secret-id');
    expect(body).not.toContain('no-such-route');
    // Neither the scrape nor the health checks are measured.
    expect(body).not.toMatch(/route="[A-Z]+ \/(metrics|health)/);
  });

  it('counts the calls to a deprecated route', async () => {
    await app.inject({ method: 'GET', url: '/probe/old/route' });
    await app.inject({ method: 'GET', url: '/probe/old/route' });
    const { body } = await scrape();
    expect(body).toMatch(
      /^deprecated_route_calls_total\{route="GET \/probe\/old\/route"\} 2$/m,
    );
  });
});

describe('GET /metrics without METRICS_TOKEN (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    app = await bootModules(MetricsModule);
  });
  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('answers 404, with or without a bearer', async () => {
    const plain = await app.inject({ method: 'GET', url: '/metrics' });
    expect(plain.statusCode).toBe(404);
    const bearer = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer anything-at-all-long-enough' },
    });
    expect(bearer.statusCode).toBe(404);
  });
});
