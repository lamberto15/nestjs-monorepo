import { createServer } from 'node:http';
import { HttpException, type INestApplicationContext } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * The worker's probes: it has no HTTP server of its own (an application
 * context), so this answers `GET /health/live` and `GET /health/ready` on
 * `port` with the same checks as the API's, and nothing else. Custom
 * because Nest's HTTP adapter would also mount every controller of the app.
 * Unref'd: it never keeps the process alive once the app has closed.
 */
export function serveWorkerHealth(app: INestApplicationContext, port: number) {
  const health = app.get(HealthController);
  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0];
    const check =
      request.method !== 'GET'
        ? undefined
        : path === '/health/live'
          ? () => health.live()
          : path === '/health/ready' || path === '/health'
            ? () => health.ready()
            : undefined;
    if (!check) {
      response.writeHead(404).end();
      return;
    }
    let status = 200;
    let body: unknown;
    try {
      body = await check();
    } catch (error) {
      status = error instanceof HttpException ? error.getStatus() : 503;
      body = error instanceof HttpException ? error.getResponse() : undefined;
    }
    response
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(body ?? { status: 'error' }));
  });
  server.listen(port).unref();
  return server;
}
