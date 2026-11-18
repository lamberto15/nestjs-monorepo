import { randomBytes } from 'node:crypto';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UnprocessableEntityException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { integer, pgSchema, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { openCursor, sealCursor, useCursorKeys } from './cursor-seal.js';
import { Deprecated } from './deprecated.js';
import { assertUnchanged, Etag } from './etag.js';
import { HttpConventionsModule } from './http-conventions.module.js';
import {
  CORS_EXPOSED_HEADERS,
  createHttpAdapter,
  MAX_PARAM_LENGTH,
  setupHttp,
} from './http-setup.js';
import { listQuery, type ListQuery } from './list-query.js';
import { setupOpenApi } from './openapi.js';
import { countMatching, countPage } from './pagination.js';

const WEB = 'https://web.example.com';
const CURSOR_KEY = randomBytes(32).toString('base64');
const PROBLEM = 'application/problem+json; charset=utf-8';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
});
const LIST = listQuery({
  title: {
    column: things.title,
    type: 'string',
    ops: ['eq', 'contains'],
    sortable: true,
  },
});
const thingSchema = z.object({
  title: z.string().min(1),
  lines: z.array(z.object({ quantity: z.number().int().min(1) })).optional(),
});

/** Routes that exercise the conventions; only this file serves them. */
@Controller('things')
class ThingsController {
  private current = { id: 'a', title: 'First' };

  @Get()
  @Etag()
  list(@Query({ schema: LIST.schema }) query: ListQuery) {
    return { items: [this.current], nextCursor: null, limit: query.limit };
  }

  @Post()
  create(@Body({ schema: thingSchema }) body: z.infer<typeof thingSchema>) {
    return body;
  }

  @Post('form')
  form(@Body({ schema: z.record(z.string(), z.string()) }) body: object) {
    return body;
  }

  @Get('big')
  @Etag()
  big() {
    return { text: 'x'.repeat(4096) };
  }

  @Get('crash')
  crash() {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
  }

  @Get('deprecated/old')
  @Deprecated({
    since: '2026-01-01',
    sunset: '2027-01-01',
    link: 'https://example.com/docs/deprecations/old',
    successor: 'https://example.com/v2/new',
  })
  old() {
    return { ok: true };
  }

  @Get('fail/:status')
  fail(@Param('status') status: string) {
    const errors: Record<string, Error> = {
      '401': new UnauthorizedException(),
      '403': new ForbiddenException(),
      '409': new ConflictException({ code: 'taken', message: 'Taken.' }),
      '422': new UnprocessableEntityException(),
    };
    throw errors[status] ?? new NotFoundException();
  }

  @Get(':id')
  @Etag()
  one(@Param('id') id: string) {
    return { ...this.current, id };
  }

  @Patch('a')
  update(
    @Headers('if-match') ifMatch: string | undefined,
    @Body({ schema: thingSchema.pick({ title: true }) })
    body: { title: string },
  ) {
    assertUnchanged(ifMatch, this.current);
    this.current = { ...this.current, ...body };
    return this.current;
  }
}

@Controller({ path: 'ping', version: VERSION_NEUTRAL })
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

describe('HTTP conventions (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    Object.assign(process.env, { CORS_ORIGINS: WEB, CURSOR_KEYS: CURSOR_KEY });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        HttpConventionsModule,
      ],
      controllers: [ThingsController, PingController],
    }).compile();
    app = moduleRef.createNestApplication<NestNodeApplication>(
      createHttpAdapter(),
      { logger: false },
    );
    setupHttp(app);
    setupOpenApi(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    delete process.env.CORS_ORIGINS;
    delete process.env.CURSOR_KEYS;
  });

  const json = (
    method: 'POST' | 'PATCH',
    url: string,
    payload: string,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      payload,
      headers: { 'content-type': 'application/json', ...headers },
    });

  describe('problem details', () => {
    it('answers a nested validation error with the dotted path of the field', async () => {
      const res = await json(
        'POST',
        '/v1/things',
        JSON.stringify({
          title: 'x',
          lines: [{ quantity: 1 }, { quantity: 0 }],
        }),
        { 'x-request-id': 'req-nested-0001' },
      );
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toBe(PROBLEM);
      expect(res.json()).toMatchObject({
        code: 'validation_failed',
        requestId: 'req-nested-0001',
        instance: '/v1/things',
        errors: [{ path: 'lines.1.quantity', message: expect.any(String) }],
      });
    });

    it('answers 401, 403, 404, 409 and 422 as problems with their codes', async () => {
      for (const [status, code] of [
        [401, 'unauthorized'],
        [403, 'forbidden'],
        [404, 'not_found'],
        [409, 'taken'],
        [422, 'unprocessable_entity'],
      ] as const) {
        const res = await app.inject(`/v1/things/fail/${status}`);
        expect(res.statusCode).toBe(status);
        expect(res.headers['content-type']).toBe(PROBLEM);
        expect(res.json()).toMatchObject({
          type: 'about:blank',
          status,
          code,
          title: expect.any(String),
          detail: expect.any(String),
          requestId: res.headers['x-request-id'],
        });
      }
    });

    it('never shows the internals of an unexpected error', async () => {
      const res = await app.inject('/v1/things/crash');
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({
        code: 'internal_error',
        detail: 'Something went wrong on our side.',
      });
      expect(res.body).not.toContain('ECONNREFUSED');
    });

    it('replaces a request id that is not safe to log, and echoes a good one', async () => {
      const replaced = await app.inject({
        url: '/v1/nowhere',
        headers: { 'x-request-id': 'bad id with spaces' },
      });
      expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(replaced.json().requestId).toBe(replaced.headers['x-request-id']);
      const tooShort = await app.inject({
        url: '/v1/nowhere',
        headers: { 'x-request-id': 'abc' },
      });
      expect(tooShort.json().requestId).not.toBe('abc');
      const good = await app.inject({
        url: '/v1/nowhere',
        headers: { 'x-request-id': 'proxy:req.0001-a_b' },
      });
      expect(good.json().requestId).toBe('proxy:req.0001-a_b');
    });

    it('drops the query string from instance', async () => {
      const res = await app.inject('/v1/things?limit=0&secret=1');
      expect(res.statusCode).toBe(400);
      expect(res.json().instance).toBe('/v1/things');
    });

    it('answers a malformed JSON body with a 400 problem that has a request id', async () => {
      const res = await json('POST', '/v1/things', '{"title":', {
        'x-request-id': '<script>x</script>',
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toBe(PROBLEM);
      expect(res.json()).toMatchObject({ status: 400, code: 'bad_request' });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.json().requestId).toBe(res.headers['x-request-id']);
    });

    it("never echoes a malformed JSON body's text in the problem", async () => {
      const res = await json('POST', '/v1/things', '"secret-in-the-body"');
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: 'bad_request',
        detail: 'Bad Request',
      });
      expect(res.body).not.toContain('secret-in-the-body');
    });

    it('answers a body over the size limit with 413 payload_too_large, without internals', async () => {
      const res = await json(
        'POST',
        '/v1/things',
        JSON.stringify({ title: 'x'.repeat(200_000) }),
      );
      expect(res.statusCode).toBe(413);
      expect(res.headers['content-type']).toBe(PROBLEM);
      expect(res.json().code).toBe('payload_too_large');
      expect(res.body).not.toMatch(/limit|entity|stack/i);
    });

    it('parses an HTML form post, up to 10 parameters', async () => {
      const post = (fields: number) =>
        app.inject({
          method: 'POST',
          url: '/v1/things/form',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload: new URLSearchParams(
            Array.from({ length: fields }, (_, i) => [`k${i}`, 'v']),
          ).toString(),
        });
      const ok = await post(10);
      expect(ok.statusCode).toBe(201);
      expect(Object.keys(ok.json())).toHaveLength(10);
      expect((await post(11)).statusCode).toBe(413);
    });

    it('answers a JSON body in an unsupported charset with 415', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/things',
        payload: '{"title":"x"}',
        headers: { 'content-type': 'application/json; charset=klingon' },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().code).toBe('unsupported_media_type');
    });

    it('answers a body that is not JSON, or none, with a 400 validation problem', async () => {
      for (const type of ['text/plain', 'application/xml']) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/things',
          payload: 'title=x',
          headers: { 'content-type': type },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json().code).toBe('validation_failed');
      }
      const empty = await app.inject({ method: 'POST', url: '/v1/things' });
      expect(empty.json().code).toBe('validation_failed');
    });

    it('matches paths case-sensitively, and answers an unknown method as a 404 problem', async () => {
      expect((await app.inject('/v1/things')).statusCode).toBe(200);
      expect((await app.inject('/V1/things')).json().code).toBe('not_found');
      const put = await app.inject({ method: 'PUT', url: '/v1/things' });
      expect(put.statusCode).toBe(404);
      expect(put.headers['content-type']).toBe(PROBLEM);
    });

    it('answers a path parameter over the length limit with 414', async () => {
      const fits = await app.inject(
        `/v1/things/${'a'.repeat(MAX_PARAM_LENGTH)}`,
      );
      expect(fits.statusCode).toBe(200);
      const res = await app.inject(
        `/v1/things/${'a'.repeat(MAX_PARAM_LENGTH + 1)}`,
      );
      expect(res.statusCode).toBe(414);
      expect(res.headers['content-type']).toBe(PROBLEM);
    });

    it('answers a percent-encoding that is not UTF-8 with a 400, not a 500', async () => {
      const res = await app.inject('/v1/things/%E0%A4%A');
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toBe(PROBLEM);
    });
  });

  describe('versions', () => {
    it('serves the API under /v1 only, and version-neutral routes unversioned', async () => {
      expect((await app.inject('/v1/things')).statusCode).toBe(200);
      for (const url of ['/things', '/v0/things', '/v2/things', '/v1/ping']) {
        expect((await app.inject(url)).statusCode, url).toBe(404);
      }
      expect((await app.inject('/v2/things')).json()).toMatchObject({
        code: 'not_found',
        instance: '/v2/things',
      });
      expect((await app.inject('/ping')).statusCode).toBe(200);
    });
  });

  describe('lists', () => {
    it("validates a list's query: bounds, unknown keys; lang is allowed", async () => {
      expect((await app.inject('/v1/things')).json().limit).toBe(50);
      for (const query of ['limit=0', 'limit=101', 'secret=1', 'title.gt=a']) {
        const res = await app.inject(`/v1/things?${query}`);
        expect(res.statusCode, query).toBe(400);
        expect(res.json().code).toBe('validation_failed');
      }
      expect((await app.inject('/v1/things?lang=de')).statusCode).toBe(200);
    });

    it('seals cursors with CURSOR_KEYS', () => {
      const sealed = sealCursor('x', 'c');
      useCursorKeys([CURSOR_KEY]);
      expect(openCursor(sealed, 'c')).toBe('x');
    });
  });

  describe('concurrency and caching', () => {
    it('answers with an ETag, 304 while unchanged, and refuses a stale If-Match with 412', async () => {
      const first = await app.inject('/v1/things/a');
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^"[A-Za-z0-9_-]{27}"$/);
      expect(first.headers['cache-control']).toBe('private, no-cache');
      const unchanged = await app.inject({
        url: '/v1/things/a',
        headers: { 'if-none-match': etag },
      });
      expect(unchanged.statusCode).toBe(304);
      expect(unchanged.body).toBe('');

      const changed = await json(
        'PATCH',
        '/v1/things/a',
        JSON.stringify({ title: 'Second' }),
        { 'if-match': etag },
      );
      expect(changed.statusCode).toBe(200);
      const stale = await json(
        'PATCH',
        '/v1/things/a',
        JSON.stringify({ title: 'Third' }),
        { 'if-match': etag },
      );
      expect(stale.statusCode).toBe(412);
      expect(stale.headers['content-type']).toBe(PROBLEM);
      expect(stale.json()).toMatchObject({
        code: 'precondition_failed',
        etag: (await app.inject('/v1/things/a')).headers.etag,
      });
      const again = await app.inject({
        url: '/v1/things/a',
        headers: { 'if-none-match': etag },
      });
      expect(again.statusCode).toBe(200);
      const any = await json(
        'PATCH',
        '/v1/things/a',
        JSON.stringify({ title: 'Third' }),
        { 'if-match': '*' },
      );
      expect(any.statusCode).toBe(200);
    });

    it('gzips a large response, leaves its ETag untouched, and still 304s', async () => {
      const got = await app.inject({
        url: '/v1/things/big',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(got.headers['content-encoding']).toBe('gzip');
      const etag = got.headers.etag as string;
      expect(etag).toMatch(/^"[\w-]+"$/);
      const again = await app.inject({
        url: '/v1/things/big',
        headers: { 'accept-encoding': 'gzip', 'if-none-match': etag },
      });
      expect(again.statusCode).toBe(304);
      const tiny = await app.inject({
        url: '/ping',
        headers: { 'accept-encoding': 'gzip' },
      });
      expect(tiny.headers['content-encoding']).toBeUndefined();
    });
  });

  describe('deprecated routes', () => {
    it('signals the deprecation in headers, only on the deprecated route', async () => {
      const old = await app.inject('/v1/things/deprecated/old');
      expect(old.headers.deprecation).toBe('@1767225600');
      expect(old.headers.sunset).toBe('Fri, 01 Jan 2027 00:00:00 GMT');
      expect(old.headers.link).toContain(
        '<https://example.com/docs/deprecations/old>; rel="deprecation"',
      );
      expect(old.headers.link).toContain('rel="successor-version"');
      const current = await app.inject('/v1/things/a');
      expect(current.headers.deprecation).toBeUndefined();
      expect(current.headers.sunset).toBeUndefined();
    });
  });

  describe('browsers', () => {
    it('sends the security headers', async () => {
      const res = await app.inject('/ping');
      expect(res.headers['strict-transport-security']).toBe(
        'max-age=63072000; includeSubDomains',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
      const csp = res.headers['content-security-policy'] as string;
      expect(csp).toContain("default-src 'self'");
      // Not production: plain-HTTP development keeps working.
      expect(csp).not.toContain('upgrade-insecure-requests');
    });

    it('lets a browser app on CORS_ORIGINS read the exposed headers, and no other origin', async () => {
      const res = await app.inject({
        url: '/v1/things',
        headers: { origin: WEB },
      });
      expect(res.headers['access-control-allow-origin']).toBe(WEB);
      const exposed = (res.headers['access-control-expose-headers'] as string)
        .split(',')
        .map((name) => name.trim().toLowerCase());
      expect(exposed).toEqual(
        CORS_EXPOSED_HEADERS.map((name) => name.toLowerCase()),
      );
      const evil = await app.inject({
        url: '/v1/things',
        headers: { origin: 'https://evil.example.com' },
      });
      expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    });

    it("refuses another site's writes with a 403 problem; CORS_ORIGINS and non-browsers may write", async () => {
      const body = JSON.stringify({ title: 'x' });
      const refused = await json('POST', '/v1/things', body, {
        origin: 'https://evil.example.com',
        'sec-fetch-site': 'cross-site',
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.headers['content-type']).toBe(PROBLEM);
      expect(refused.json()).toMatchObject({
        code: 'forbidden',
        requestId: refused.headers['x-request-id'],
      });
      const trusted = await json('POST', '/v1/things', body, {
        origin: WEB,
        'sec-fetch-site': 'cross-site',
      });
      expect(trusted.statusCode).toBe(201);
      expect((await json('POST', '/v1/things', body)).statusCode).toBe(201);
    });
  });

  describe('OpenAPI', () => {
    it('documents the routes, deprecations and security schemes at /api-json', async () => {
      const document = (await app.inject('/api-json')).json() as {
        paths: Record<string, { get?: { deprecated?: boolean } }>;
        components: { securitySchemes: Record<string, unknown> };
      };
      expect(document.paths['/v1/things/deprecated/old']?.get?.deprecated).toBe(
        true,
      );
      expect(document.paths['/v1/things/a']?.get?.deprecated).toBeUndefined();
      expect(document.paths['/ping']).toBeDefined();
      expect(Object.keys(document.components.securitySchemes).sort()).toEqual([
        'api-key',
        'user-session',
        'user-token',
      ]);
      expect((await app.inject('/api')).statusCode).toBe(200);
    });
  });
});

describe('countPage (PostgreSQL)', () => {
  // A catalog every database has: no table of this module's own to create.
  const types = pgSchema('pg_catalog').table('pg_type', {
    oid: integer('oid').notNull(),
  });
  const db = drizzle(process.env.DATABASE_URL!);
  afterAll(() => db.$client.end());

  it('counts only when asked', async () => {
    expect(
      await countPage(db, types, undefined, { limit: 10 }),
    ).toBeUndefined();
    expect(
      await countPage(db, types, undefined, { limit: 10, count: false }),
    ).toBeUndefined();
  });

  it('counts what matches, up to the cap', async () => {
    const query = { limit: 10, count: true };
    // 16 is boolean's oid.
    expect(await countPage(db, types, eq(types.oid, 16), query)).toEqual({
      total: 1,
      totalCapped: false,
    });
    expect(await countPage(db, types, undefined, query, 3)).toEqual({
      total: 3,
      totalCapped: true,
    });
    expect(
      await countMatching(
        db,
        db.select({ oid: types.oid }).from(types),
        query,
        3,
      ),
    ).toEqual({ total: 3, totalCapped: true });
  });
});
