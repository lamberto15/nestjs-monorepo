// First: it loads .env, which the instrument below reads.
import './core/observability/instrument.js';
import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { AppModule } from './app.module.js';
import { createHttpAdapter, setupHttp } from './core/http/http-setup.js';
import { httpConfig } from './core/http/http.config.js';
import { setupOpenApi } from './core/http/openapi.js';
import { createLogger } from './core/logging/logging.js';
import { nestrixInstrument } from './core/observability/nestrix.js';
import { observeInstrument } from './core/observability/observe.js';
import { setupRealtime } from './modules/realtime/realtime.adapter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestNodeApplication>(
    AppModule,
    createHttpAdapter(),
    // Held until the logger below is in place: it masks the secrets the
    // modules' configs declared while the app was created.
    // rawBody: signed webhooks are verified on the bytes that were signed.
    {
      bufferLogs: true,
      rawBody: true,
      instrument: observeInstrument() ?? nestrixInstrument(),
    },
  );
  app.useLogger(createLogger());
  setupHttp(app);
  // Sockets on the same server, reaching every instance through Redis.
  setupRealtime(app);
  setupOpenApi(app);
  // On SIGTERM, /health/ready turns 503 for SHUTDOWN_DRAIN_MS (core/health),
  // then the server stops and the modules close what they hold.
  app.enableShutdownHooks();
  const { port } = app.get<ConfigType<typeof httpConfig>>(httpConfig.KEY, {
    strict: false,
  });
  await app.listen(port);
}
await bootstrap();
