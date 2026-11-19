import { ApplicationConfig } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../test/boot.js';
import { PermissionCatalog } from './iam/access/permission-catalog.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.OUTBOX_RELAY = 'off';
  process.env.WEBHOOKS_WORKER = 'off';
  process.env.DATA_ENCRYPTION_KEYS =
    'ZmFrZS10ZXN0LWtleS1mb3ItdGhlLWFwcC1lMmUtMDE=';
  process.env.BLIND_INDEX_KEYS = 'ZmFrZS10ZXN0LWluZGV4LWtleS1hcHAtZTJlLTAx';
  process.env.REDIS_PREFIX = `test-app-${process.pid}-${Date.now()}`;
});

/**
 * Every other e2e test boots one module. This one boots them all, as
 * main.ts does: what only shows with every module together (the order of
 * the global guards and interceptors, two modules claiming one route or
 * one permission subject) fails here, at start.
 */
describe('the whole app (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    const { AppModule } = await import('./app.module.js');
    app = await bootModules(AppModule);
  });

  afterAll(() => app?.close());

  it('starts, answers /health, and asks every other route for credentials', async () => {
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/v1/access/roles' })).statusCode).toBe(
      401,
    );
  });

  // Idempotency's boot warning lists the global interceptors outside it.
  // Only these may be: the request's language (I18nInterceptor), the trace
  // around everything (NestrixInterceptor, core/observability) and
  // nestjs-cls's pass-through (a plain object: its interceptor is off, the
  // middleware sets the context). Anything else would also see replays.
  it('runs idempotency inside only the interceptors that set context or trace', () => {
    // By name, as the warning prints them: @nestjs/idempotency doesn't
    // export its interceptor's class.
    const names = app
      .get(ApplicationConfig)
      .getGlobalInterceptors()
      .map((interceptor) => interceptor.constructor.name);
    const position = names.indexOf('IdempotencyInterceptor');
    expect(position).toBeGreaterThan(0);
    // In any order: Nestrix's comes first when it is on.
    expect(names.slice(0, position).sort()).toEqual([
      'I18nInterceptor',
      'NestrixInterceptor',
      'Object',
    ]);
  });

  // A subject two modules add to has its label in one of them: only the
  // whole app shows that none of them wrote it (a 500 on GET /v1/access/catalog).
  it('has a text for every permission and system job of every module', () => {
    const catalog = app.get(PermissionCatalog, { strict: false });
    expect(() => [catalog.view(), catalog.systemJobsView()]).not.toThrow();
  });
});
