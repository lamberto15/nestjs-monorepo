import type { ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { HttpConventionsModule } from '../src/core/http/http-conventions.module.js';
import { createHttpAdapter, setupHttp } from '../src/core/http/http-setup.js';

/**
 * Boots the given modules, and what they import, as main.ts boots the app
 * (the adapter, the HTTP conventions), for an e2e test: drive it with
 * `app.inject()`, close it with `app.close()`. ConfigModule.forRoot() is
 * what app.module.ts adds around every module, here without .env: a test's
 * environment is setup-env.ts's and its own. TEST_LOGS=1 shows the app's
 * errors and warnings.
 */
export async function bootModules(
  ...modules: NonNullable<ModuleMetadata['imports']>
): Promise<NestNodeApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      HttpConventionsModule,
      ...modules,
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestNodeApplication>(
    createHttpAdapter(),
    {
      rawBody: true,
      logger: process.env.TEST_LOGS ? ['error', 'warn'] : false,
    },
  );
  setupHttp(app);
  await app.init();
  return app;
}
