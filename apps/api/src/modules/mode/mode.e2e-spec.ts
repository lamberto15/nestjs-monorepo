import { Controller, Get, Module, Post } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { accessModules, seededAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { FeaturesModule } from '../features/features.module.js';
import { AllowInMaintenance } from '../../core/http/maintenance.js';
import { ModeModule } from './mode.module.js';
import { ModeService } from './mode.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-mode-${process.pid}-${Date.now()}`;
  process.env.OPERATOR_TENANT = 'ops';
  process.env.ADMIN_PASSWORD = 'correct horse battery staple';
  process.env.ADMIN_ONBOARDING = 'off';
});

@Controller('test-mode')
class TestModeController {
  @Get('read')
  @Can.Anyone()
  read() {
    return { ok: true };
  }

  @Post('read-by-post')
  @Can.Anyone()
  readByPost() {
    return { ok: true };
  }

  @Post('kept')
  @Can.Anyone()
  @AllowInMaintenance()
  kept() {
    return { ok: true };
  }
}

@Module({ controllers: [TestModeController] })
class TestModeModule {}

const boot = () =>
  bootModules(
    ...accessModules(),
    MetricsModule,
    ModeModule,
    FeaturesModule,
    TestModeModule,
  );

describe('deployment mode (e2e)', () => {
  let app: NestNodeApplication;
  let operators: Record<string, string>;
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
    headers = operators,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const setMode = (value: string) =>
    call('PUT', '/v1/settings/platform.mode/platform', { value });
  /** The mode is read once a second at most, and at once after a change here. */
  const modeIs = (mode: string) =>
    vi.waitFor(() => expect(app.get(ModeService).current()).toBe(mode));

  beforeAll(async () => {
    app = await boot();
    operators = (await seededAdmin(app)).headers;
  });
  afterAll(async () => {
    await app?.close();
  });

  it("refuses writes while read-only, keeps the operators' and the allowed routes, and ends it again", async () => {
    expect((await call('POST', '/v1/test-mode/read-by-post')).statusCode).toBe(
      201,
    );
    expect((await call('GET', '/v1/features')).json()).toMatchObject({
      mode: 'normal',
    });

    expect((await setMode('read-only')).statusCode).toBe(200);
    await modeIs('read-only');
    expect((await call('GET', '/v1/test-mode/read')).statusCode).toBe(200);
    const refused = await call('POST', '/v1/test-mode/read-by-post');
    expect(refused.statusCode).toBe(503);
    expect(refused.json().code).toBe('read_only');
    expect(refused.headers['retry-after']).toBe('30');
    expect((await call('POST', '/v1/test-mode/kept')).statusCode).toBe(201);
    expect((await call('GET', '/v1/features')).json()).toMatchObject({
      mode: 'read-only',
    });

    // The operators can always end it (the platform routes are allowed).
    expect(
      (await call('DELETE', '/v1/settings/platform.mode/platform')).statusCode,
    ).toBe(204);
    await modeIs('normal');
    expect((await call('POST', '/v1/test-mode/read-by-post')).statusCode).toBe(
      201,
    );
  });

  it('answers 503 maintenance to everything but what is allowed', async () => {
    await setMode('maintenance');
    await modeIs('maintenance');
    const refused = await call('GET', '/v1/test-mode/read');
    expect(refused.statusCode).toBe(503);
    expect(refused.json().code).toBe('maintenance');
    expect((await call('POST', '/v1/test-mode/kept')).statusCode).toBe(201);
    expect((await call('GET', '/v1/features')).json()).toMatchObject({
      mode: 'maintenance',
    });
    expect(
      (await call('DELETE', '/v1/settings/platform.mode/platform')).statusCode,
    ).toBe(204);
    await modeIs('normal');
    expect((await call('GET', '/v1/test-mode/read')).statusCode).toBe(200);
  });

  it("is the operators' alone to set, and a value the setting does not take is refused", async () => {
    const bad = await setMode('sleeping');
    expect(bad.statusCode).toBe(400);
  });

  it('lets APP_MODE force the mode, which a stored value then cannot change', async () => {
    process.env.APP_MODE = 'read-only';
    const forced = await boot();
    try {
      const headers = (await seededAdmin(forced)).headers;
      const put = await forced.inject({
        method: 'PUT',
        url: '/v1/settings/platform.mode/platform',
        headers,
        payload: { value: 'normal' },
      });
      expect(put.statusCode).toBe(400);
      expect(put.json().code).toBe('setting_not_allowed');
      const write = await forced.inject({
        method: 'POST',
        url: '/v1/test-mode/read-by-post',
        headers,
      });
      expect(write.json().code).toBe('read_only');
      expect(
        (
          await forced.inject({ method: 'GET', url: '/v1/features', headers })
        ).json(),
      ).toMatchObject({ mode: 'read-only' });
    } finally {
      delete process.env.APP_MODE;
      await forced.close();
    }
  });
});
