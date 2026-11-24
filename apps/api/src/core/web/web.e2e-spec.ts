import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { HealthModule } from '../health/health.module.js';
import { HttpConventionsModule } from '../http/http-conventions.module.js';
import { createHttpAdapter, setupHttp } from '../http/http-setup.js';
import { WebModule } from './web.module.js';

// Hoisted above the imports, which read the variables: its own imports are dynamic.
const ROOT = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(`${tmpdir()}/web-root-`);
  process.env.WEB_ROOT = root;
  process.env.WEB_FILES_ORIGINS = 'https://files.example.com';
  process.env.SECURITY_CONTACT = 'security@example.com';
  process.env.SECURITY_TXT_EXPIRES = '2030-01-01T00:00:00Z';
  return root;
});

@Module({
  imports: [
    ConfigModule.forRoot({ ignoreEnvFile: true }),
    HttpConventionsModule,
    HealthModule,
    WebModule,
  ],
})
class TestApp {}

describe('the web app, served by the API (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    mkdirSync(join(ROOT, 'assets'));
    writeFileSync(
      join(ROOT, 'index.html'),
      '<!doctype html><title>App</title>',
    );
    writeFileSync(join(ROOT, 'assets', 'app-abc123.js'), 'console.log(1)');
    writeFileSync(join(ROOT, 'version.json'), '{"sha":"abc"}');
    // As main.ts creates the app, not bootModules(): a testing module is
    // compiled before its HTTP adapter exists, and @nestjs/serve-static
    // chooses how to serve from the adapter it finds then (none: nothing).
    app = await NestFactory.create<NestNodeApplication>(
      TestApp,
      createHttpAdapter(),
      { logger: false },
    );
    setupHttp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    rmSync(ROOT, { recursive: true, force: true });
  });

  const get = (url: string) => app.inject({ method: 'GET', url });

  it('serves the page at / and on any path of the app, never cached, with its own policy', async () => {
    for (const url of ['/', '/settings/roles', '/invoices/42?tab=files']) {
      const page = await get(url);
      expect(page.statusCode, url).toBe(200);
      expect(page.body, url).toContain('<title>App</title>');
      expect(page.headers['cache-control'], url).toBe('no-cache');
      expect(page.headers['content-security-policy'], url).toContain(
        "connect-src 'self' https://files.example.com",
      );
      expect(page.headers['content-security-policy'], url).toContain(
        'https://challenges.cloudflare.com',
      );
      expect(page.headers['x-frame-options'], url).toBe('DENY');
    }
  });

  it('serves content-named assets for a year, other files uncached', async () => {
    const asset = await get('/assets/app-abc123.js');
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    const version = await get('/version.json');
    expect(version.json()).toEqual({ sha: 'abc' });
    expect(version.headers['cache-control']).toBe('no-cache');
  });

  it('publishes /.well-known/security.txt from SECURITY_CONTACT', async () => {
    const txt = await get('/.well-known/security.txt');
    expect(txt.statusCode).toBe(200);
    expect(txt.headers['content-type']).toMatch(/^text\/plain/);
    expect(txt.body).toBe(
      'Contact: mailto:security@example.com\nExpires: 2030-01-01T00:00:00.000Z\nPreferred-Languages: en\n',
    );
  });

  it("leaves the API's paths to the API: a route answers, an unknown one is a 404, not the page", async () => {
    expect((await get('/health/live')).json()).toMatchObject({ status: 'ok' });
    for (const url of [
      '/v1/nothing',
      '/v2/nothing',
      '/api-json',
      '/files/nothing',
      '/.well-known/nothing',
      '/assets/missing.js',
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.body, url).not.toContain('<title>App</title>');
    }
  });
});
