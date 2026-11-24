import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { DatabaseModule } from '../database/database.module.js';
import { HealthModule } from './health.module.js';

describe('health', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(DatabaseModule, HealthModule);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health is 200 when PostgreSQL answers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      info: { database: { status: 'up' } },
    });
  });

  it('GET /health/ready is the same check', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      info: { database: { status: 'up' } },
    });
  });

  it('GET /health/live is 200 without asking the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', info: {} });
  });
});
