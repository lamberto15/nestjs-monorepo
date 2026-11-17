import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { accessModules, tenantWithAdmin } from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { ecbDocument } from './ecb-document.testing.js';
import { parseEcbRates } from './ecb-rates.js';
import { ExchangeRatesJob } from './exchange-rates.job.js';
import { ExchangeRatesService } from './exchange-rates.service.js';
import { Money } from './money.js';
import { EXCHANGE_RATES_JOB } from './money.permissions.js';
import { MoneyModule } from './money.module.js';
import { exchangeRates } from './money.tables.js';

/**
 * A stand-in for the ECB's eurofxref documents on loopback (the tests never
 * reach the real one), started before the module loads. It serves what
 * `documents` holds, or 503 while `down`, and records what it was asked.
 */
const ecb = await vi.hoisted(async () => {
  const { createServer } = await import('node:http');
  const documents: Record<string, string> = {};
  const requests: string[] = [];
  const state = { down: false };
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const name = /^\/stats\/eurofxref\/([\w-]+\.xml)$/.exec(req.url ?? '')?.[1];
    if (state.down) {
      res.writeHead(503).end('maintenance');
      return;
    }
    if (!name || !documents[name]) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/xml' }).end(documents[name]);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const scrapeKey = ['money', 'scrape', String(port)].join('-');
  Object.assign(process.env, {
    SCHEDULER: 'off',
    REDIS_PREFIX: `test-money-${process.pid}-${Date.now()}`,
    EXCHANGE_RATES_FETCH: 'on',
    EXCHANGE_RATES_ECB_URL: `http://127.0.0.1:${port}/stats/eurofxref`,
    METRICS_TOKEN: scrapeKey,
  });
  return {
    documents,
    requests,
    state,
    scrapeKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
});

describe('exchange rates and the money routes (e2e)', () => {
  let app: NestNodeApplication;
  let db: Database;
  let headers: Record<string, string>;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), MetricsModule, MoneyModule);
    db = app.get(getDrizzleToken());
    headers = (await tenantWithAdmin(app)).admin.headers;
  });
  afterAll(async () => {
    await app.close();
    await ecb.close();
  });

  const job = () => app.get(ExchangeRatesJob);
  const rates = () => app.get(ExchangeRatesService);
  const get = (url: string, extra: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers: { ...headers, ...extra } });
  const scrape = async () =>
    (
      await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${ecb.scrapeKey}` },
      })
    ).body;

  // Thursday 2026-10-15, after the ECB published (15:00 UTC).
  const THURSDAY = new Date('2026-10-15T15:07:00Z');
  const HISTORY = ecbDocument({
    '2026-10-14': { USD: '1.1601', JPY: '174.90', GBP: '0.8650' },
    '2026-10-13': { USD: '1.1599', JPY: '174.10', GBP: '0.8640' },
    '2026-10-09': { USD: '1.1500', JPY: '173.00', GBP: '0.8600' },
  });
  const DAILY = ecbDocument({
    '2026-10-15': { USD: '1.1652', JPY: '175.32', GBP: '0.8689' },
  });

  it('answers 404 and 422 before any rate is stored, and the age gauge reads +Inf', async () => {
    const none = await get('/v1/money/rates');
    expect(none.statusCode).toBe(404);
    expect(none.json().code).toBe('rates_unavailable');
    const convert = await get(
      '/v1/money/convert?amount=10&currency=USD&to=EUR',
    );
    expect(convert.statusCode).toBe(422);
    expect(convert.json()).toMatchObject({ code: 'rate_unavailable' });
    expect(await scrape()).toMatch(/^exchange_rates_age_seconds \+Inf$/m);
  });

  it('keeps what it has when the ECB is down: the run reports the failure, the next one retries', async () => {
    ecb.state.down = true;
    try {
      expect(await job().refresh(THURSDAY)).toMatchObject({
        status: 'failed',
        newest: null,
      });
    } finally {
      ecb.state.down = false;
    }
    expect(await rates().newestDay()).toBeNull();
  });

  it('fetches the 90-day history first, as the system principal of its job', async () => {
    ecb.documents['eurofxref-hist-90d.xml'] = HISTORY;
    ecb.requests.length = 0;
    const run = vi.spyOn(app.get(SystemContext), 'run');
    try {
      // Wednesday after 15:00: the 14th is expected, nothing stored yet.
      expect(await job().refresh(new Date('2026-10-14T16:07:00Z'))).toEqual({
        status: 'fetched',
        newest: '2026-10-14',
        days: 3,
        rows: 9,
      });
      expect(run).toHaveBeenCalledWith(
        EXCHANGE_RATES_JOB,
        expect.any(Function),
        { transaction: false, tenantId: null },
      );
    } finally {
      run.mockRestore();
    }
    expect(ecb.requests).toEqual(['/stats/eurofxref/eurofxref-hist-90d.xml']);
    // Up to date: no second request.
    expect(await job().refresh(new Date('2026-10-14T17:07:00Z'))).toEqual({
      status: 'current',
      newest: '2026-10-14',
    });
    expect(ecb.requests).toHaveLength(1);
  });

  it('then takes the daily document, and stores an ECB correction over the old rate', async () => {
    ecb.documents['eurofxref-daily.xml'] = DAILY;
    expect(await job().refresh(THURSDAY)).toMatchObject({
      status: 'fetched',
      newest: '2026-10-15',
      days: 1,
    });
    expect(ecb.requests.at(-1)).toBe('/stats/eurofxref/eurofxref-daily.xml');

    const usdOn15th = async () =>
      (
        await db
          .select()
          .from(exchangeRates)
          .where(
            and(
              eq(exchangeRates.day, '2026-10-15'),
              eq(exchangeRates.currency, 'USD'),
            ),
          )
      )[0]!;
    expect(await usdOn15th()).toMatchObject({
      source: 'ecb',
      base: 'EUR',
      rate: '1.1652',
    });
    // Only the corrected row is written; the same document again writes none.
    const corrected = parseEcbRates(
      ecbDocument({
        '2026-10-15': { USD: '1.1655', JPY: '175.32', GBP: '0.8689' },
      }),
    );
    expect(await rates().store(corrected)).toBe(1);
    expect(await rates().store(corrected)).toBe(0);
    expect((await usdOn15th()).rate).toBe('1.1655');
    // Back to the published value for the rest of the file.
    expect(await rates().store(parseEcbRates(DAILY))).toBe(1);
  });

  it('serves a day’s rates: the newest working day on or before the date, as strings, with an ETag', async () => {
    const today = await get('/v1/money/rates?date=2026-10-15');
    expect(today.statusCode).toBe(200);
    expect(today.json()).toEqual({
      source: 'ecb',
      base: 'EUR',
      day: '2026-10-15',
      rates: { GBP: '0.8689', JPY: '175.32', USD: '1.1652' },
    });
    // A weekend (and the gap of the 10th to the 12th) takes the working day before.
    const sunday = (await get('/v1/money/rates?date=2026-10-11')).json();
    expect(sunday.day).toBe('2026-10-09');
    expect(sunday.rates.USD).toBe('1.1500');
    expect((await get('/v1/money/rates?date=2026-01-01')).statusCode).toBe(404);
    expect((await get('/v1/money/rates?date=yesterday')).statusCode).toBe(400);
    const again = await get('/v1/money/rates?date=2026-10-15', {
      'if-none-match': today.headers.etag as string,
    });
    expect(again.statusCode).toBe(304);
  });

  it('converts through the euro with one rounding, and says at which rate, day and source', async () => {
    const res = await get(
      '/v1/money/convert?amount=10&currency=USD&to=JPY&date=2026-10-15',
    );
    expect(res.statusCode).toBe(200);
    // 10 / 1.1652 × 175.32 = 1504.634…
    expect(res.json()).toEqual({
      from: { amount: '10.00', currency: 'USD' },
      amount: { amount: '1505', currency: 'JPY' },
      rate: '150.4634397528',
      rateDate: '2026-10-15',
      source: 'ecb',
      base: 'EUR',
      legs: { from: '1.1652', to: '175.32' },
      rounding: 'half-up',
    });

    // From the base, at the rates of a past day (a Monday with none: the Friday before).
    const eur = (
      await get(
        '/v1/money/convert?amount=-100&currency=EUR&to=GBP&date=2026-10-12',
      )
    ).json();
    expect(eur).toMatchObject({
      amount: { amount: '-86.00', currency: 'GBP' },
      rateDate: '2026-10-09',
      legs: { from: '1', to: '0.8600' },
    });

    // 1.00 EUR at 0.8689 GBP: 0.87 half-up, 0.86 rounded down.
    const down = (
      await get(
        '/v1/money/convert?amount=1&currency=EUR&to=GBP&date=2026-10-15&rounding=down',
      )
    ).json();
    expect(down.amount).toEqual({ amount: '0.86', currency: 'GBP' });
    expect(down.rounding).toBe('down');

    const same = (
      await get('/v1/money/convert?amount=5&currency=JPY&to=JPY')
    ).json();
    expect(same).toMatchObject({
      amount: { amount: '5', currency: 'JPY' },
      rate: '1',
      source: 'identity',
    });
  });

  it('refuses what it can’t convert exactly, with a problem', async () => {
    const precision = await get(
      '/v1/money/convert?amount=12.345&currency=EUR&to=USD',
    );
    expect(precision.statusCode).toBe(400);
    expect(precision.json().code).toBe('validation_failed');
    expect(precision.json().errors[0].path).toBe('amount');

    const unknown = await get('/v1/money/convert?amount=1&currency=EUR&to=XAU');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().errors[0].path).toBe('to');
    expect(
      (await get('/v1/money/convert?amount=1e3&currency=EUR&to=USD'))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await get(
          '/v1/money/convert?amount=1&currency=EUR&to=USD&rounding=nearest',
        )
      ).statusCode,
    ).toBe(400);

    // The ECB doesn't publish dirhams.
    const aed = await get('/v1/money/convert?amount=1&currency=AED&to=EUR');
    expect(aed.statusCode).toBe(422);
    expect(aed.json()).toMatchObject({ code: 'rate_unavailable' });
    expect(aed.json().detail).toMatch(/No exchange rate for AED/);
  });

  it('lets any signed-in principal read rates, and nobody else', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/v1/money/rates',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('exposes how old the newest rates are', async () => {
    const age = /^exchange_rates_age_seconds (\d+(\.\d+)?(e\+\d+)?)$/m.exec(
      await scrape(),
    );
    expect(age).not.toBeNull();
    const expected = (Date.now() - Date.parse('2026-10-15T00:00:00Z')) / 1000;
    expect(Math.abs(Number(age![1]) - expected)).toBeLessThan(60);
  });

  it('throws its error in services, for the problem-details filter to map', async () => {
    await expect(
      rates().convert(Money.of('1', 'AED'), 'USD', { day: '2026-10-15' }),
    ).rejects.toMatchObject({ code: 'rate_unavailable' });
    const converted = await rates().convert(Money.of('100', 'USD'), 'EUR', {
      day: '2026-10-15',
      rounding: 'half-even',
    });
    // 100 / 1.1652 = 85.8221…
    expect(converted.amount.toJSON()).toEqual({
      amount: '85.82',
      currency: 'EUR',
    });
    expect(converted).toMatchObject({ rateDate: '2026-10-15', source: 'ecb' });
  });
});
