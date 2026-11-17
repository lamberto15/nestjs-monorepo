import { Controller, Get, Module } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules, seededAdmin } from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { UsageModule } from './usage.module.js';
import { apiClientQuotas } from './usage.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.USAGE = 'off';
  process.env.REDIS_PREFIX = `test-usage-off-${process.pid}-${Date.now()}`;
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
});

@Controller('ping')
class PingController {
  @Get()
  @Can.Anyone()
  ping() {
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class PingModule {}

/** USAGE=off: no metering, no quota enforcement, no usage routes. */
describe('USAGE=off (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), UsageModule, PingModule);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('does not enforce a stored daily quota or send quota headers, and leaves the usage routes out', async () => {
    const admin = await seededAdmin(app);
    const client = await apiClient(app, admin.tenantId);
    await app
      .get(Tenancy)
      .run(admin.tenantId, () =>
        app
          .get<Database>(getDrizzleToken())
          .insert(apiClientQuotas)
          .values({ clientId: client.client.id, dailyQuota: 1 }),
      );
    for (let i = 0; i < 3; i++) {
      const answer = await app.inject({
        method: 'GET',
        url: '/v1/ping',
        headers: client.headers,
      });
      expect(answer.statusCode).toBe(200);
      expect(answer.headers['x-quota-limit']).toBeUndefined();
    }
    const own = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: client.headers,
    });
    expect(own.statusCode).toBe(404);
    expect(own.json().code).toBe('feature_off');
    const seen = await app.inject({
      method: 'GET',
      url: `/v1/access/clients/${client.client.id}/usage`,
      headers: admin.headers,
    });
    expect(seen.statusCode).toBe(404);
  });
});
