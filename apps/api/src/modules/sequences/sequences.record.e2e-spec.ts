import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { NumberedItemsModule } from '../../../test/fixtures/sequences/numbered-items.module.js';
import { ReferencedItemsModule } from '../../../test/fixtures/sequences/referenced-items.module.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { dateValues } from './naming-pattern.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-record-numbers-${process.pid}-${Date.now()}`;
});

describe('numbered records (e2e)', () => {
  let app: NestNodeApplication;
  const year = dateValues(new Date(), 'UTC').YYYY;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      NumberedItemsModule,
      ReferencedItemsModule,
      // The records a referenced item refers to.
      testItemsModule(),
    );
  });
  afterAll(async () => {
    await app?.close();
  });

  // A tenant of its own per test: each numbers its own series from 1.
  const create = (
    headers: Record<string, string>,
    payload: Record<string, unknown>,
  ) =>
    app.inject({ method: 'POST', url: '/v1/numbered-items', headers, payload });

  it('numbers each record when it is created, without gaps, and lists by number', async () => {
    const { editor } = await recordsTenant(app);
    const first = await create(editor.headers, { title: 'One' });
    expect(first.statusCode).toBe(201);
    expect(first.json().number).toBe(`NI-${year}-0001`);

    // A create that rolls back takes no number.
    await create(editor.headers, { title: 'Two', code: 'dup' });
    const clash = await create(editor.headers, { title: 'Three', code: 'dup' });
    expect(clash.statusCode).toBe(409);
    const next = await create(editor.headers, { title: 'Four' });
    expect(next.json().number).toBe(`NI-${year}-0003`);

    const shown = await app.inject({
      method: 'GET',
      url: `/v1/numbered-items/${first.json().id}`,
      headers: editor.headers,
    });
    expect(shown.json().number).toBe(`NI-${year}-0001`);

    const sorted = await app.inject({
      method: 'GET',
      url: '/v1/numbered-items?sort=-number',
      headers: editor.headers,
    });
    expect(
      sorted.json().items.map((item: { number: string }) => item.number),
    ).toEqual([`NI-${year}-0003`, `NI-${year}-0002`, `NI-${year}-0001`]);
    const filtered = await app.inject({
      method: 'GET',
      url: `/v1/numbered-items?number=NI-${year}-0002`,
      headers: editor.headers,
    });
    expect(
      filtered.json().items.map((item: { title: string }) => item.title),
    ).toEqual(['Two']);
  });

  it("numbers by the tenant's naming series, chosen in the body or by the default", async () => {
    const { admin, editor } = await recordsTenant(app);
    const series = async (payload: Record<string, unknown>) => {
      const made = await app.inject({
        method: 'POST',
        url: '/v1/naming-series',
        headers: admin.headers,
        payload: { subject: 'NumberedItem', ...payload },
      });
      expect(made.statusCode).toBe(201);
      return made.json<{ id: string }>();
    };
    const byRegion = await series({ pattern: 'R-.{region}.-.###' });
    await series({ pattern: 'ALL-.###', isDefault: true });

    const chosen = await create(editor.headers, {
      title: 'EU',
      region: 'EU',
      namingSeriesId: byRegion.id,
    });
    expect(chosen.json().number).toBe('R-EU-001');
    const fallback = await create(editor.headers, { title: 'Any' });
    expect(fallback.json().number).toBe('ALL-001');
    // A series of another subject, or none at all: refused.
    const unknown = await create(editor.headers, {
      title: 'Bad',
      namingSeriesId: '0192e0a0-0000-7000-8000-000000000000',
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('reads up a chain of references: a pattern of A, B and C, a counter for each', async () => {
    const { admin } = await recordsTenant(app);
    const { headers } = admin;
    // D → C → B → A: a referenced item, its test item, that one's parent, and its parent's.
    const a = await createTestItem(app, headers, { title: 'A', code: 'A01' });
    const b = await createTestItem(app, headers, {
      title: 'B',
      code: 'B02',
      parentId: a.id,
    });
    const c = await createTestItem(app, headers, {
      title: 'C',
      code: 'C03',
      parentId: b.id,
    });
    const other = await createTestItem(app, headers, {
      title: 'C again',
      code: 'C04',
      parentId: b.id,
    });
    const series = await app.inject({
      method: 'POST',
      url: '/v1/naming-series',
      headers,
      payload: {
        subject: 'ReferencedItem',
        pattern:
          '.{item_parent_parent_code}.-.{item_parent_code}.-.{item_code}.-.###',
      },
    });
    expect(series.statusCode, series.body).toBe(201);
    const reference = async (itemId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/referenced-items',
        headers,
        payload: { itemId },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ reference: string }>().reference;
    };
    expect(await reference(c.id)).toBe('A01-B02-C03-001');
    expect(await reference(c.id)).toBe('A01-B02-C03-002');
    expect(await reference(other.id)).toBe('A01-B02-C04-001');
  });

  it("fills a record's own field from its series when a create leaves it empty, and keeps one typed in", async () => {
    const { admin } = await recordsTenant(app);
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/referenced-items',
        headers: admin.headers,
        payload,
      });
    const first = await post({});
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().reference).toBe(`REF-${year}-0001`);
    expect(first.json()).not.toHaveProperty('number');
    const typed = await post({ reference: 'MINE' });
    expect(typed.json().reference).toBe('MINE');

    // A tenant's own series, printing the record's fields.
    const series = await app.inject({
      method: 'POST',
      url: '/v1/naming-series',
      headers: admin.headers,
      payload: { subject: 'ReferencedItem', pattern: '.{region}.-.###' },
    });
    expect(series.statusCode, series.body).toBe(201);
    const next = await post({ region: 'EU' });
    expect(next.json().reference).toBe('EU-001');
  });

  it('skips a number a record already holds, typed in ahead of the series', async () => {
    const { admin } = await recordsTenant(app);
    const post = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/v1/referenced-items',
        headers: admin.headers,
        payload,
      });
    expect((await post({})).json().reference).toBe(`REF-${year}-0001`);
    // Typed in: the numbers the series gives next.
    for (const reference of [`REF-${year}-0002`, `REF-${year}-0003`]) {
      expect((await post({ reference })).statusCode).toBe(201);
    }
    const next = await post({});
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json().reference).toBe(`REF-${year}-0004`);
  });

  it("picks and prints by a referenced record's field: a company's own series and code", async () => {
    const { admin } = await recordsTenant(app);
    const { headers } = admin;
    // Test items stand for companies: their `code`.
    const acme = await createTestItem(app, headers, {
      title: 'Acme',
      code: 'ACME',
    });
    const globex = await createTestItem(app, headers, {
      title: 'Globex',
      code: 'GLX',
    });
    const nameless = await createTestItem(app, headers, { title: 'Nameless' });
    const series = (payload: object) =>
      app.inject({
        method: 'POST',
        url: '/v1/naming-series',
        headers,
        payload: { subject: 'ReferencedItem', ...payload },
      });
    // The first series is the default: every company without its own.
    expect((await series({ pattern: '.#####' })).statusCode).toBe(201);
    const glx = await series({
      pattern: '.{item_code}.-.####',
      conditions: [{ field: 'item_code', op: 'eq', value: 'GLX' }],
    });
    expect(glx.statusCode, glx.body).toBe(201);
    const post = async (payload: Record<string, unknown>) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/referenced-items',
        headers,
        payload,
      });
      return response;
    };
    const reference = async (payload: Record<string, unknown>) => {
      const response = await post(payload);
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ reference: string }>().reference;
    };
    expect(await reference({ itemId: acme.id })).toBe('00001');
    expect(await reference({ itemId: globex.id })).toBe('GLX-0001');
    expect(await reference({ itemId: globex.id })).toBe('GLX-0002');
    expect(await reference({ itemId: acme.id })).toBe('00002');
    // No company: the default.
    expect(await reference({})).toBe('00003');

    // A series printing a code the company lacks: a 400 that says so.
    const lacking = await post({
      itemId: nameless.id,
      namingSeriesId: glx.json<{ id: string }>().id,
    });
    expect(lacking.statusCode).toBe(400);
    expect(lacking.body).toContain('item_code');

    // A referenced field that isn't one: refused when the series is saved.
    const unknown = await series({
      pattern: '.####',
      conditions: [{ field: 'item_nope', op: 'eq', value: 'X' }],
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('reads up a chain of references: a pattern of A, B and C, a counter for each', async () => {
    const { admin } = await recordsTenant(app);
    const { headers } = admin;
    // D → C → B → A: a referenced item, its test item, that one's parent, and its parent's.
    const a = await createTestItem(app, headers, { title: 'A', code: 'A01' });
    const b = await createTestItem(app, headers, {
      title: 'B',
      code: 'B02',
      parentId: a.id,
    });
    const c = await createTestItem(app, headers, {
      title: 'C',
      code: 'C03',
      parentId: b.id,
    });
    const other = await createTestItem(app, headers, {
      title: 'C again',
      code: 'C04',
      parentId: b.id,
    });
    const series = await app.inject({
      method: 'POST',
      url: '/v1/naming-series',
      headers,
      payload: {
        subject: 'ReferencedItem',
        pattern:
          '.{item_parent_parent_code}.-.{item_parent_code}.-.{item_code}.-.###',
      },
    });
    expect(series.statusCode, series.body).toBe(201);
    const reference = async (itemId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/referenced-items',
        headers,
        payload: { itemId },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json<{ reference: string }>().reference;
    };
    expect(await reference(c.id)).toBe('A01-B02-C03-001');
    expect(await reference(c.id)).toBe('A01-B02-C03-002');
    expect(await reference(other.id)).toBe('A01-B02-C04-001');
  });
});
