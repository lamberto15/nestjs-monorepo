import type { ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { overrideModels } from '@nestjs/ai/testing';
import type { LanguageModel } from 'ai';
import { HttpConventionsModule } from '../../../src/core/http/http-conventions.module.js';
import {
  createHttpAdapter,
  setupHttp,
} from '../../../src/core/http/http-setup.js';

/**
 * `bootModules()` (test/boot.ts) with the AI models replaced by fakes
 * (@nestjs/ai/testing): the real API is never called. The models are named
 * as the app configures them (`default`, `cheap`).
 */
export async function bootWithModels(
  models: Record<string, LanguageModel>,
  ...modules: NonNullable<ModuleMetadata['imports']>
): Promise<NestNodeApplication> {
  const moduleRef = await overrideModels(
    Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        HttpConventionsModule,
        ...modules,
      ],
    }),
    models,
  ).compile();
  const app = moduleRef.createNestApplication<NestNodeApplication>(
    createHttpAdapter(),
    { rawBody: true, logger: false },
  );
  setupHttp(app);
  await app.init();
  return app;
}
