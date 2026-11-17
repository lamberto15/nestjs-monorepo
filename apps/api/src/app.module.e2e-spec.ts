import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../test/boot.js';

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
});
