import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { ClientErrorsModule } from './client-errors.module.js';
import { ThrottlingModule } from '../../core/throttling/throttling.module.js';

// Read when the module loads: the throttler's counts live in Redis, so each
// run gets its own prefix and a rerun within the minute isn't refused.
vi.hoisted(() => {
  process.env.REDIS_PREFIX = `test-client-errors-${process.pid}`;
});

const report = {
  id: 'abc12345',
  source: 'window',
  message: 'TypeError: boom',
  stack: 'TypeError: boom\n  at x (app.js:1:1)',
  path: '/sign-in',
};

/** POST /v1/client-errors: apps/web/src/lib/report-error.ts's `send`. */
describe('client errors (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(ThrottlingModule, ClientErrorsModule);
  });
  afterAll(async () => {
    await app.close();
    delete process.env.REDIS_PREFIX;
  });

  it('logs a report with no sign-in, and answers 204', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/client-errors',
      payload: report,
    });
    expect(response.statusCode).toBe(204);
  });

  it('refuses a report past the field limits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/client-errors',
      payload: { ...report, message: 'x'.repeat(2001) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('validation_failed');
  });

  it('refuses an unknown source', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/client-errors',
      payload: { ...report, source: 'made-up' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('answers 429 problem details once an address exceeds its limit', async () => {
    // 120 a minute: the three requests above count too, so the refusal comes
    // within the first 120 of this loop.
    let refused: Awaited<ReturnType<NestNodeApplication['inject']>> | undefined;
    for (let hit = 0; hit < 200 && !refused; hit++) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/client-errors',
        payload: report,
      });
      if (response.statusCode === 429) {
        refused = response;
      }
    }
    expect(refused).toBeDefined();
    expect(refused?.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(Number(refused?.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused?.json()).toMatchObject({
      status: 429,
      code: 'rate_limited',
      instance: '/v1/client-errors',
    });
  });
});
