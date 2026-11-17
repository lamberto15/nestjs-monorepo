import { NestFactory } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { AppModule } from './app.module.js';
import { createHttpAdapter, setupHttp } from './core/http/http-setup.js';
import { setupOpenApi } from './core/http/openapi.js';
import { createLogger } from './core/logging/logging.js';

async function bootstrap() {
  const app = await NestFactory.create<NestNodeApplication>(
    AppModule,
    createHttpAdapter(),
    // Held until the logger below is in place: it masks the secrets the
    // modules' configs declared while the app was created.
    { bufferLogs: true },
  );
  app.useLogger(createLogger());
  setupHttp(app);
  setupOpenApi(app);
  // On SIGTERM, /health turns 503 and the modules close what they hold.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
