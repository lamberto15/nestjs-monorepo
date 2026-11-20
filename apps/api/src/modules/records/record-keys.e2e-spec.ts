import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { bootModules } from '../../../test/boot.js';
import { keyedModules } from '../../../test/fixtures/keyed/keyed.module.js';
import {
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { SharedLocksModule } from '../../core/locks/locks.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { DATA_TRANSFERS } from '../data-transfer/data-transfer.service.js';
import { dateValues } from '../sequences/naming-pattern.js';
import { StorageModule } from '../storage/storage.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    REDIS_PREFIX: `test-record-keys-${process.pid}-${Date.now()}`,
  });
});

/** The path and query of a signed URL: the tests reach the app without a port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url, 'http://localhost');
  return pathname + search;
};

/** A multipart body: the text fields, then the CSV file. */
function multipart(fields: Record<string, string>, csv: string) {
  const boundary = `----test${randomUUID()}`;
  const parts = Object.entries(fields).map(
    ([name, value]) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    payload: Buffer.from(
      `${parts.join('')}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rows.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
    ),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

type Transfer = {
  status: string;
  result?: {
    url?: string;
    imported?: number;
    failed?: number;
    errorsUrl?: string;
  };
};

describe('record keys (e2e)', () => {
  let app: NestNodeApplication;
  const year = dateValues(new Date(), 'UTC').YYYY;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      SharedLocksModule,
      ...keyedModules(),
    );
  });
  afterAll(async () => {
    await app
      ?.get<Queue>(getQueueToken(DATA_TRANSFERS))
      .obliterate({ force: true });
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, payload });

  const created = async (url: string, headers: Headers, payload: object) => {
    const response = await call('POST', url, headers, payload);
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: string } & Record<string, unknown>>();
  };

  async function settled(id: string, headers: Headers) {
    for (let tries = 0; tries < 400; tries++) {
      const transfer = (
        await call('GET', `/v1/data/transfers/${id}`, headers)
      ).json<Transfer>();
      if (['completed', 'failed'].includes(transfer.status)) return transfer;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Transfer ${id} did not end`);
  }

  const exported = async (name: string, headers: Headers) => {
    const started = await call('POST', '/v1/data/exports', headers, { name });
    expect(started.statusCode, started.body).toBe(202);
    const done = await settled(started.json<{ id: string }>().id, headers);
    const file = await call('GET', local(done.result!.url!), headers);
    return file.body
      .replace(/^\u{feff}/u, '')
      .trim()
      .split('\r\n')
      .map((line) => line.split(','));
  };

  const imported = async (
    name: string,
    csv: string,
    headers: Headers,
    fields: Record<string, string> = {},
  ) => {
    const body = multipart({ name, ...fields }, csv);
    const started = await app.inject({
      method: 'POST',
      url: '/v1/data/imports',
      headers: { ...headers, ...body.headers },
      payload: body.payload,
    });
    expect(started.statusCode, started.body).toBe(202);
    return settled(started.json<{ id: string }>().id, headers);
  };

  /** A tenant with shelf S1 holding book B1, and shelf S2 holding another B1. */
  async function library() {
    const team = await recordsTenant(app);
    const { headers } = team.admin;
    const s1 = await created('/v1/keyed-shelves', headers, { code: 'S1' });
    const s2 = await created('/v1/keyed-shelves', headers, { code: 'S2' });
    const b1 = await created('/v1/keyed-books', headers, {
      shelfId: s1.id,
      code: 'B1',
      title: 'First',
    });
    const other = await created('/v1/keyed-books', headers, {
      shelfId: s2.id,
      code: 'B1',
      title: 'Elsewhere',
    });
    return { team, headers, s1, s2, b1, other };
  }

  it('keeps a key unique within its parent, not across parents', async () => {
    const { headers, s1 } = await library();
    // B1 on S2 was created above; a second B1 on S1 is refused.
    const clash = await call('POST', '/v1/keyed-books', headers, {
      shelfId: s1.id,
      code: 'B1',
    });
    expect(clash.statusCode).toBe(409);
  });

  it('shows a reference by its key path', async () => {
    const { headers, b1 } = await library();
    const loan = await created('/v1/keyed-loans', headers, {
      bookId: b1.id,
      reference: 'L-1',
    });
    const shown = await call(
      'GET',
      `/v1/keyed-loans/${loan.id}?include=book`,
      headers,
    );
    expect(shown.json()).toMatchObject({
      reference: 'L-1',
      book: { id: b1.id, key: 'S1/B1' },
    });
  });

  it('exports keys, never ids: its own key first, a reference as its path', async () => {
    const { headers, b1 } = await library();
    await created('/v1/keyed-loans', headers, {
      bookId: b1.id,
      reference: 'L-7',
    });
    const [header, row] = await exported('keyed-loans', headers);
    expect(header![0]).toBe('reference');
    expect(header).toContain('book');
    expect(header).not.toContain('bookId');
    expect(row![0]).toBe('L-7');
    expect(row![header!.indexOf('book')]).toBe('S1/B1');

    const books = await exported('keyed-books', headers);
    expect(books[0]![0]).toBe('code');
    expect(books[0]).toContain('shelf');
  });

  it('imports references by their key paths, and names a key it does not know', async () => {
    const { headers, b1, other } = await library();
    const done = await imported(
      'keyed-loans',
      'reference,book\nL-10,S1/B1\nL-11,S2/B1\nL-12,S9/B1\n',
      headers,
    );
    expect(done.result).toMatchObject({ imported: 2, failed: 1 });
    const errors = await call('GET', local(done.result!.errorsUrl!), headers);
    expect(errors.body).toMatch(
      /3,book,"No keyed book whose code is ""S9\/B1""\."/,
    );
    const loans = (
      await call('GET', '/v1/keyed-loans?limit=100', headers)
    ).json<{ items: { reference: string; bookId: string }[] }>().items;
    expect(
      Object.fromEntries(loans.map((loan) => [loan.reference, loan.bookId])),
    ).toEqual({ 'L-10': b1.id, 'L-11': other.id });
  });

  it('matches a key unique within its parent within the row’s parent', async () => {
    const { headers, b1, other } = await library();
    const done = await imported(
      'keyed-books',
      'code,shelf,title\nB1,S2,Renamed\n',
      headers,
      { matchOn: 'code' },
    );
    expect(done.result).toMatchObject({ imported: 1, failed: 0 });
    const title = async (id: string) =>
      (await call('GET', `/v1/keyed-books/${id}`, headers)).json<{
        title: string;
      }>().title;
    expect(await title(other.id)).toBe('Renamed');
    expect(await title(b1.id)).toBe('First');
  });

  it('numbers an empty key from its naming series, which may print its references’ keys', async () => {
    const { headers, b1 } = await library();
    // Until a series is defined: the declared default.
    const first = await created('/v1/keyed-loans', headers, { bookId: b1.id });
    expect(first.reference).toBe(`LN-${year}-0001`);
    // A key typed in is kept.
    const typed = await created('/v1/keyed-loans', headers, {
      bookId: b1.id,
      reference: 'MINE',
    });
    expect(typed.reference).toBe('MINE');

    const series = await call('POST', '/v1/naming-series', headers, {
      subject: 'KeyedLoan',
      pattern: '.{book_shelf}.-.{book}.-.###',
    });
    expect(series.statusCode, series.body).toBe(201);
    const next = await created('/v1/keyed-loans', headers, { bookId: b1.id });
    expect(next.reference).toBe('S1-B1-001');
  });
});
