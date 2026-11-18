import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dumpTarget } from './core/http/openapi-dump-target.js';

/**
 * Writes the OpenAPI document to a file without serving it (`pnpm
 * openapi:dump`, which builds first: `node dist/openapi-dump [file]`), for
 * the typed client in packages/api-client: its openapi.json by default.
 * Another file is a .json in the repository or the temp directory
 * (dumpTarget).
 *
 * The app is created in NestJS's preview mode: modules and routes are
 * scanned, nothing is instantiated, so no database, Redis or port is needed.
 * The environment is a fixed one, not the developer's: the document is a
 * contract committed to the repository, so it must come out the same on
 * every machine and in CI.
 */
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:5432/openapi',
  REDIS_URL: 'redis://127.0.0.1:6379',
  APP_URL: 'http://localhost:3000',
  OPENAPI: 'on',
});

let target: string;
try {
  target = dumpTarget(process.argv[2]);
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

// After the environment: the modules' configs read it when they are imported.
const { VersioningType } = await import('@nestjs/common');
const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./app.module.js');
const { buildOpenApiDocument } = await import('./core/http/openapi.js');
// Record add-ons that AppModule does not list (a feature takes them with
// `forRecord()`) put their schemas and realtime events in the document when
// loaded: the client's record panels type their routes from those.
await Promise.all([
  import('./modules/comments/comments.module.js'),
  import('./modules/merge/merge.module.js'),
  import('./modules/revisions/revisions.module.js'),
]);

const app = await NestFactory.create(AppModule, {
  preview: true,
  logger: ['error'],
  abortOnError: false,
});
// What setupHttp() applies and the document shows (it reads the config,
// which preview mode doesn't instantiate).
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
const document = buildOpenApiDocument(app);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
console.log(`OpenAPI document: ${target}`);
await app.close();
