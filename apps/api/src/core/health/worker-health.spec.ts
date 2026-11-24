import type { AddressInfo } from 'node:net';
import { ServiceUnavailableException } from '@nestjs/common';
import { serveWorkerHealth } from './worker-health.js';

describe('serveWorkerHealth', () => {
  const live = vi.fn(async () => ({ status: 'ok' }));
  const ready = vi.fn(async () => ({ status: 'ok' }));
  const app = { get: () => ({ live, ready }) } as never;
  const server = serveWorkerHealth(app, 0);
  const url = (path: string) =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;

  beforeAll(async () => {
    if (!server.listening) {
      await new Promise((resolve) => server.once('listening', resolve));
    }
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('answers liveness and readiness', async () => {
    expect((await fetch(url('/health/live'))).status).toBe(200);
    const response = await fetch(url('/health/ready'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers 503 with the failing checks while not ready', async () => {
    ready.mockRejectedValueOnce(
      new ServiceUnavailableException({
        status: 'error',
        error: { redis: {} },
      }),
    );
    const response = await fetch(url('/health/ready'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { redis: {} } });
  });

  it('answers nothing else', async () => {
    expect((await fetch(url('/v1/notes'))).status).toBe(404);
    expect((await fetch(url('/health/live'), { method: 'POST' })).status).toBe(
      404,
    );
  });
});
