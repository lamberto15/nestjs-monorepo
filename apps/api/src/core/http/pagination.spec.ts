import type { SQL } from 'drizzle-orm';
import { PgDialect, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sortSchema } from './list-sort.js';
import { COUNT_CAP, pageOffset, WALK_BATCH, walkList } from './pagination.js';

const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull(),
});
const dialect = new PgDialect();
const sql = (query: SQL | undefined) => dialect.sqlToQuery(query!);

describe('walkList (exports walk a list by keyset)', () => {
  it('reads batches in the list order, each after the last row of the one before, until a short batch', async () => {
    const sort = sortSchema({
      at: {
        column: auditLog.at,
        type: 'datetime',
        ops: [],
        sortable: true,
      },
    }).parse('-at');
    const row = (n: number) => ({
      id: `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`,
      at: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, n)),
    });
    const reads: { after: SQL | undefined; orderBy: SQL[]; limit: number }[] =
      [];
    const batches = [
      Array.from({ length: WALK_BATCH }, (_, n) => row(n)),
      [row(WALK_BATCH)],
    ];
    const seen: number[] = [];
    for await (const rows of walkList(
      auditLog.id,
      { limit: 50, cursor: 'ignored', sort },
      (page) => {
        reads.push(page);
        return Promise.resolve(batches[reads.length - 1] ?? []);
      },
    )) {
      seen.push(rows.length);
    }
    expect(seen).toEqual([WALK_BATCH, 1]);
    expect(reads.map((read) => read.limit)).toEqual([WALK_BATCH, WALK_BATCH]);
    // The first batch starts at the top; the second after the last row's
    // sort value and id: the list's own cursor condition, a row comparison
    // an index range can serve.
    expect(reads[0]!.after).toBeUndefined();
    expect(sql(reads[1]!.after).sql).toContain('"audit_log"."id") < (');
    expect(sql(reads[1]!.after).params).toContain(
      row(WALK_BATCH - 1).at.toISOString(),
    );
    expect(sql(reads[0]!.orderBy[0]).sql).toContain('desc nulls first');
  });

  it('pages by id alone, newest first, without a sort', async () => {
    const reads: SQL[][] = [];
    for await (const rows of walkList(
      auditLog.id,
      { limit: 50 },
      ({ orderBy }) => {
        reads.push(orderBy);
        return Promise.resolve([]);
      },
    )) {
      expect(rows).toEqual([]);
    }
    expect(reads).toHaveLength(1);
    expect(reads[0]).toHaveLength(1);
  });
});

describe('pageOffset (pages by number)', () => {
  const page = (page: number | undefined, limit = 50) =>
    pageOffset({ page, limit } as Parameters<typeof pageOffset>[0]);

  it('skips the rows of the pages before, none for a cursor page', () => {
    expect(page(undefined)).toBe(0);
    expect(page(1)).toBe(0);
    expect(page(3, 20)).toBe(40);
  });

  it('refuses a page that starts past COUNT_CAP, as a 400 on `page`', () => {
    expect(page(COUNT_CAP / 50)).toBe(COUNT_CAP - 50);
    expect(() => page(COUNT_CAP / 50 + 1)).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({
          code: 'validation_failed',
          errors: [expect.objectContaining({ path: 'page' })],
        }),
      }),
    );
  });
});
