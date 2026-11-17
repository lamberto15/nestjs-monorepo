import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Body, Controller, Get, Post } from '@nestjs/common';
import { I18nLoader, I18nService } from '@nestjs/i18n';
import { type NestNodeApplication, NodeAdapter } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { ModuleCatalogLoader } from './catalog.loader.js';
import { HttpConventionsModule } from '../http/http-conventions.module.js';
import { I18nModule } from './i18n.module.js';

const body = z.object({ name: z.string().min(3) });

@Controller()
class DemoController {
  constructor(private readonly i18n: I18nService) {}

  @Get('hello')
  hello() {
    return { text: this.i18n.t('demo.hello') };
  }

  @Post('items')
  create(@Body({ schema: body }) dto: z.infer<typeof body>) {
    return dto;
  }
}

describe('i18n', () => {
  let app: NestNodeApplication;
  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });

  beforeAll(async () => {
    // A second language, enabled for this run: the core ships English only.
    process.env.LOCALES = 'en,de';
    // A module's texts, next to the ones the core ships (src/core/i18n/<locale>.json).
    const demo = await mkdtemp(join(tmpdir(), 'i18n-'));
    await mkdir(join(demo, 'demo/i18n'), { recursive: true });
    for (const [locale, hello] of [
      ['en', 'Hello'],
      ['de', 'Hallo'],
    ]) {
      await writeFile(
        join(demo, `demo/i18n/${locale}.json`),
        JSON.stringify({ demo: { hello } }),
      );
    }
    const core = join(import.meta.dirname, '../..');
    const moduleRef = await Test.createTestingModule({
      // HttpConventionsModule: the validation pipe that reads the catalog.
      imports: [I18nModule, HttpConventionsModule],
      controllers: [DemoController],
    })
      .overrideProvider(I18nLoader)
      .useValue({
        async load() {
          const [a, b] = await Promise.all([
            new ModuleCatalogLoader(core, ['en']).load(),
            new ModuleCatalogLoader(demo, ['en', 'de']).load(),
          ]);
          for (const locale of Object.keys(b)) {
            a[locale] = { ...a[locale], ...b[locale] };
          }
          return a;
        },
      })
      .compile();
    app = moduleRef.createNestApplication<NestNodeApplication>(
      new NodeAdapter(),
    );
    await app.init();
  });

  afterAll(async () => {
    delete process.env.LOCALES;
    await app.close();
  });

  it('defaults to the first locale and says so', async () => {
    const res = await get('/hello');
    expect(res.json()).toEqual({ text: 'Hello' });
    expect(res.headers['content-language']).toBe('en');
  });

  it('resolves ?lang, then X-Lang, then Accept-Language', async () => {
    const both = await get('/hello?lang=de', { 'x-lang': 'en' });
    expect(both.json()).toEqual({ text: 'Hallo' });
    expect((await get('/hello', { 'x-lang': 'de' })).json()).toEqual({
      text: 'Hallo',
    });
    const accept = await get('/hello', { 'accept-language': 'fr, de;q=0.8' });
    expect(accept.json()).toEqual({ text: 'Hallo' });
  });

  it('falls back to the default locale for an unsupported language', async () => {
    expect((await get('/hello?lang=fr')).json()).toEqual({ text: 'Hello' });
  });

  it('translates validation messages from the core catalog', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { name: 'ab' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('must be at least 3 characters long');
  });
});
