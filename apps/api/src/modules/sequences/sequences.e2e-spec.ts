import { getDrizzleToken } from '@nestjs/drizzle';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import { NumberedWidgetsModule } from '../../../test/fixtures/sequences/numbered-widgets.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { dateValues } from './naming-pattern.js';
import { NamingSeriesService } from './naming-series.service.js';
import { SequencesService } from './sequences.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-sequences-${process.pid}-${Date.now()}`;
});

type Headers = Record<string, string>;

describe('sequences and naming series (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;
  let editor: Headers;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), NumberedWidgetsModule);
  });
  afterAll(() => app.close());
  // A tenant of its own per test: counters outlive their series, so tests would share them.
  beforeEach(async () => {
    ({
      tenantId,
      admin: { headers: admin },
    } = await tenantWithAdmin(app));
    editor = (await member(app, tenantId, ['editor'])).headers;
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);
  /** Today's date parts in UTC (SEQUENCES_TIMEZONE's default), as the numbers print them. */
  const today = () => dateValues(new Date(), 'UTC');

  const series = async (
    pattern: string,
    extra: Record<string, unknown> = {},
    headers = admin,
  ) => {
    const created = await call('POST', '/v1/naming-series', headers, {
      subject: 'Widget',
      pattern,
      ...extra,
    });
    expect(created.statusCode).toBe(201);
    return created.json() as {
      id: string;
      isDefault: boolean;
      example: string;
    };
  };
  const widget = (extra: Record<string, unknown> = {}, headers = admin) =>
    call('POST', '/v1/widgets', headers, extra);
  const numberOf = async (extra: Record<string, unknown> = {}) => {
    const created = await widget(extra);
    expect(created.statusCode).toBe(201);
    return created.json().number as string;
  };
  const entries = (action: string, targetId: string) =>
    app.get(Tenancy).run(tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
        ),
    );

  describe('gapless numbers', () => {
    it('number without gaps, even written at once or rolled back, and per year', async () => {
      const { YYYY } = today();
      const plain = (extra: object = {}) =>
        call('POST', '/v1/widgets/plain', admin, extra);
      expect((await plain()).json().number).toBe(`PW-${YYYY}-001`);
      const written = await Promise.all(
        Array.from({ length: 20 }, () => plain()),
      );
      const numbers = written
        .map((each) => each.json().number as string)
        .toSorted();
      expect(new Set(numbers).size).toBe(20);
      expect(numbers[0]).toBe(`PW-${YYYY}-002`);
      expect(numbers[19]).toBe(`PW-${YYYY}-021`);

      // A write that rolls back takes no number.
      expect((await plain({ fail: true })).statusCode).toBe(500);
      expect((await plain()).json().number).toBe(`PW-${YYYY}-022`);

      // Another year, another scope: their own series.
      const sequences = app.get(SequencesService);
      const txHost = app.get(TransactionHost);
      const inTenant = <T>(work: () => Promise<T>) =>
        app.get(Tenancy).run(tenantId, () => txHost.withTransaction(work));
      const last = new Date(Date.UTC(Number(YYYY) - 1, 5, 1));
      expect(
        (
          await inTenant(() =>
            sequences.next('plain-widget', {
              prefix: 'PW',
              perYear: true,
              width: 3,
              at: last,
            }),
          )
        ).formatted,
      ).toBe(`PW-${Number(YYYY) - 1}-001`);
      expect(
        await inTenant(() =>
          sequences.next('invoice', {
            scope: 'unit-a',
            prefix: 'INV',
            width: 3,
          }),
        ),
      ).toEqual({ value: 1, formatted: 'INV-001' });
      expect(
        await app
          .get(Tenancy)
          .run(tenantId, () =>
            sequences.current('invoice', { scope: 'unit-a' }),
          ),
      ).toBe(1);

      // Outside a transaction the row lock would end at once: refused.
      await expect(
        app.get(Tenancy).run(tenantId, () => sequences.next('invoice')),
      ).rejects.toThrow(/inside a transaction/);
    });
  });

  describe('naming series', () => {
    it('lets only naming series managers change them; anyone signed in reads them', async () => {
      const denied = [
        call('POST', '/v1/naming-series', editor, {
          subject: 'Widget',
          pattern: 'X-.###',
        }),
        call('POST', '/v1/naming-series/preview', editor, {
          subject: 'Widget',
          pattern: 'X-.###',
        }),
      ];
      for (const response of await Promise.all(denied))
        expect(response.statusCode).toBe(403);

      const subjects = (
        await call('GET', '/v1/naming-series/subjects', editor)
      ).json();
      expect(subjects.items).toEqual(
        expect.arrayContaining([
          {
            subject: 'Widget',
            declaredPattern: 'WG-.YYYY.-.#####',
            fields: [
              { name: 'title', kind: 'text' },
              { name: 'code', kind: 'text' },
              { name: 'publishedAt', kind: 'datetime' },
            ],
          },
        ]),
      );
      const variables = (
        await call('GET', '/v1/naming-series/variables', editor)
      ).json();
      expect(
        variables.items.map((variable: { name: string }) => variable.name),
      ).toEqual(expect.arrayContaining(['FY', 'ABBR']));

      const { id } = await series('WG-.YYYY.-.#####', { label: 'Widgets' });
      const listed = (
        await call('GET', '/v1/naming-series?subject=Widget', editor)
      ).json();
      expect(listed.items).toMatchObject([
        { id, pattern: 'WG-.YYYY.-.#####', label: 'Widgets', isDefault: true },
      ]);
      expect(
        (
          await call('PATCH', `/v1/naming-series/${id}`, editor, {
            label: 'Mine',
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call('PUT', `/v1/naming-series/${id}/counter`, editor, {
            current: 10,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await call('DELETE', `/v1/naming-series/${id}`, editor)).statusCode,
      ).toBe(403);
    });

    it('refuses invalid patterns, unknown subjects and a pattern taken', async () => {
      for (const pattern of ['INV-.YYYY.', '.###.-.###', 'IN<V>.###']) {
        const refused = await call('POST', '/v1/naming-series', admin, {
          subject: 'Widget',
          pattern,
        });
        expect(refused.statusCode).toBe(400);
        expect(paths(refused.json())).toEqual(['pattern']);
      }
      const unknown = await call('POST', '/v1/naming-series', admin, {
        subject: 'Invoice',
        pattern: 'INV-.###',
      });
      expect(paths(unknown.json())).toEqual(['subject']);

      await series('A-.###');
      const taken = await call('POST', '/v1/naming-series', admin, {
        subject: 'Widget',
        pattern: 'A-.###',
      });
      expect(taken.statusCode).toBe(409);

      const preview = await call('POST', '/v1/naming-series/preview', admin, {
        subject: 'Widget',
        pattern: 'A-.',
      });
      expect(paths(preview.json())).toEqual(['pattern']);

      for (const [extra, path] of [
        [{ pattern: 'A-.{price}.-.###' }, 'pattern'],
        [{ pattern: 'A-.{code}.###' }, 'pattern'],
        [{ pattern: 'A-.###', dateField: 'title' }, 'dateField'],
        [
          {
            pattern: 'A-.###',
            conditions: [{ field: 'price', op: 'eq', value: 'x' }],
          },
          'conditions.0.field',
        ],
      ] as const) {
        const refused = await call('POST', '/v1/naming-series', admin, {
          subject: 'Widget',
          ...extra,
        });
        expect(refused.statusCode).toBe(400);
        expect(paths(refused.json())).toEqual([path]);
      }
    });

    it('numbers in the default series or the one the body names, carrying on the declared counter', async () => {
      const { YYYY, MM } = today();
      // Before any series: the declared format.
      expect(await numberOf()).toBe(`WG-${YYYY}-00001`);
      expect(await numberOf()).toBe(`WG-${YYYY}-00002`);

      // The first series is the default; printing what the declared format
      // prints, it carries on its counter: no second WG-<year>-00001.
      const main = await series('WG-.YYYY.-.#####');
      expect(main).toMatchObject({
        isDefault: true,
        example: `WG-${YYYY}-00003`,
      });
      expect(await numberOf()).toBe(`WG-${YYYY}-00003`);

      const monthly = await series('CN-.YYYY.-.MM.-.###', {
        label: 'Credit notes',
      });
      expect(monthly.isDefault).toBe(false);
      expect(await numberOf({ namingSeriesId: monthly.id })).toBe(
        `CN-${YYYY}-${MM}-001`,
      );
      expect(await numberOf()).toBe(`WG-${YYYY}-00004`);

      // Made the default, it numbers what names none; the other stops being it.
      expect(
        (
          await call('PATCH', `/v1/naming-series/${monthly.id}`, admin, {
            isDefault: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(await numberOf()).toBe(`CN-${YYYY}-${MM}-002`);
      const defaults = (
        await call(
          'GET',
          '/v1/naming-series?subject=Widget&isDefault=true',
          admin,
        )
      ).json();
      expect(defaults.items.map((row: { id: string }) => row.id)).toEqual([
        monthly.id,
      ]);

      // No such series: refused, nothing taken.
      const refused = await widget({
        namingSeriesId: '0198a7f0-0000-7000-8000-000000000000',
      });
      expect(refused.statusCode).toBe(400);
      expect(paths(refused.json())).toEqual(['namingSeriesId']);

      // Deleting the default: the oldest series left takes over.
      expect(
        (await call('DELETE', `/v1/naming-series/${monthly.id}`, admin))
          .statusCode,
      ).toBe(204);
      expect(
        (await call('GET', `/v1/naming-series/${main.id}`, admin)).json()
          .isDefault,
      ).toBe(true);
      expect(await numberOf()).toBe(`WG-${YYYY}-00005`);
      expect(await entries('namingSeries.deleted', monthly.id)).toHaveLength(1);
    });

    it('starts a counter at a value, never below what is taken, audited', async () => {
      const { YYYY } = today();
      const { id } = await series('INV-.YYYY.-.####');
      expect(await numberOf()).toBe(`INV-${YYYY}-0001`);

      const set = await call('PUT', `/v1/naming-series/${id}/counter`, admin, {
        current: 1000,
      });
      expect(set.statusCode).toBe(200);
      expect(set.json()).toEqual({
        key: `INV-${YYYY}-{#}`,
        current: 1000,
        next: `INV-${YYYY}-1001`,
      });
      expect(await numberOf()).toBe(`INV-${YYYY}-1001`);

      expect(
        (
          await call('PUT', `/v1/naming-series/${id}/counter`, admin, {
            current: 1000,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await call('GET', `/v1/naming-series/${id}/counter`, admin)).json()
          .current,
      ).toBe(1001);

      // A pattern printing the same shares the counter, whatever its width.
      const preview = await call('POST', '/v1/naming-series/preview', admin, {
        subject: 'Widget',
        pattern: 'INV-.YYYY.-.######',
      });
      expect(preview.json()).toEqual({
        key: `INV-${YYYY}-{#}`,
        current: 1001,
        next: `INV-${YYYY}-001002`,
      });

      const [entry] = await entries('namingSeries.counterSet', id);
      expect(entry).toMatchObject({ details: { from: 1, to: 1000 } });
    });

    it('gives each of many writes at once its own number', async () => {
      const { YYYY } = today();
      await series('B-.YYYY.-.###');
      const numbers = await Promise.all(
        Array.from({ length: 12 }, () => numberOf()),
      );
      expect(numbers.toSorted()).toEqual(
        Array.from(
          { length: 12 },
          (_, index) => `B-${YYYY}-${String(index + 1).padStart(3, '0')}`,
        ),
      );
    });

    it('restarts a series when its date parts change', async () => {
      const service = app.get(NamingSeriesService);
      const txHost = app.get(TransactionHost);
      const { id } = await series('M-.YY.MM.-.##');
      const take = (at: Date) =>
        app
          .get(Tenancy)
          .run(tenantId, () =>
            txHost.withTransaction(() =>
              service.next('Widget', { seriesId: id, at }),
            ),
          );
      const january = new Date('2030-01-15T12:00:00Z');
      const february = new Date('2030-02-15T12:00:00Z');
      expect((await take(january)).formatted).toBe('M-3001-01');
      expect((await take(january)).formatted).toBe('M-3001-02');
      expect((await take(february)).formatted).toBe('M-3002-01');
      expect((await take(january)).formatted).toBe('M-3001-03');
    });

    it("prints the record's fields, each value counting on its own", async () => {
      const yy = today().YY;
      const { id } = await series('WG-.{code}.-.YY.-.###');
      expect(await numberOf({ code: 'acme 1' })).toBe(`WG-acme-1-${yy}-001`);
      expect(await numberOf({ code: 'globex' })).toBe(`WG-globex-${yy}-001`);

      const refused = await widget();
      expect(refused.statusCode).toBe(400);
      expect(paths(refused.json())).toEqual(['code']);

      const preview = await call('POST', '/v1/naming-series/preview', admin, {
        subject: 'Widget',
        pattern: 'WG-.{code}.-.YY.-.###',
        values: { code: 'globex' },
      });
      expect(preview.json()).toMatchObject({
        current: 1,
        next: `WG-globex-${yy}-002`,
      });
      const set = await call('PUT', `/v1/naming-series/${id}/counter`, admin, {
        current: 50,
        values: { code: 'globex' },
      });
      expect(set.json().next).toBe(`WG-globex-${yy}-051`);
      const needsValue = await call(
        'PUT',
        `/v1/naming-series/${id}/counter`,
        admin,
        { current: 50 },
      );
      expect(paths(needsValue.json())).toEqual(['values.code']);
      expect(
        (await call('GET', `/v1/naming-series/${id}`, admin)).json().example,
      ).toBe(`WG-{code}-${yy}-001`);
    });

    it('picks the series whose conditions hold, by priority, else the default', async () => {
      const { YYYY } = today();
      await series('WG-.YYYY.-.#####');
      await series('VIP-.####', {
        conditions: [{ field: 'code', op: 'gte', value: 'vip' }],
        priority: 10,
      });
      await series('ZED-.####', {
        conditions: [{ field: 'title', op: 'gte', value: 'Z' }],
      });
      expect(await numberOf()).toBe(`WG-${YYYY}-00001`);
      expect(await numberOf({ code: 'vip' })).toBe('VIP-0001');
      expect(await numberOf({ title: 'Zebra' })).toBe('ZED-0001');
      // Both hold: the higher priority wins.
      expect(await numberOf({ title: 'Zulu', code: 'vip2' })).toBe('VIP-0002');
      // A series the body names wins over the conditions.
      const named = await series('NAMED-.###');
      expect(await numberOf({ code: 'vip3', namingSeriesId: named.id })).toBe(
        'NAMED-001',
      );
    });

    it('takes its dates from a date field of the record, and prints the variables', async () => {
      expect(
        (
          await call('PUT', '/v1/settings/numbering.abbreviation', admin, {
            value: 'HQ',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await call('PUT', '/v1/settings/numbering.fiscalYearStart', admin, {
            value: 4,
          })
        ).statusCode,
      ).toBe(200);
      await series('.ABBR.-.FY.-.MM.-.###', { dateField: 'publishedAt' });
      // March 2030 is fiscal 2029-2030, April 2030 starts 2030-2031.
      expect(await numberOf({ publishedAt: '2030-03-15T12:00:00Z' })).toBe(
        'HQ-2029-2030-03-001',
      );
      expect(await numberOf({ publishedAt: '2030-04-15T12:00:00Z' })).toBe(
        'HQ-2030-2031-04-001',
      );
      expect(await numberOf({ publishedAt: '2030-04-20T12:00:00Z' })).toBe(
        'HQ-2030-2031-04-002',
      );
    });

    it("keeps a tenant's series and counters its own", async () => {
      const { YYYY } = today();
      await series('OURS-.###');
      expect(await numberOf()).toBe('OURS-001');

      const other = await tenantWithAdmin(app);
      const theirs = (
        await call(
          'GET',
          '/v1/naming-series?subject=Widget',
          other.admin.headers,
        )
      ).json();
      expect(theirs.items).toEqual([]);
      const created = await widget({}, other.admin.headers);
      expect(created.json().number).toBe(`WG-${YYYY}-00001`);
      await series('OURS-.###', {}, other.admin.headers);
      expect((await widget({}, other.admin.headers)).json().number).toBe(
        'OURS-001',
      );
    });
  });
});
