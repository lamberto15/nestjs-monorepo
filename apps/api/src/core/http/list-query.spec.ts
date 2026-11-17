import {
  boolean,
  integer,
  jsonb,
  PgDialect,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  fieldsRead,
  listQuery,
  type ListQuery,
  queryReads,
} from './list-query.js';
import { toPage } from './pagination.js';

const things = pgTable('things', {
  id: uuid('id').primaryKey(),
  status: text('status').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  totalCurrency: text('total_currency'),
  custom: jsonb('custom').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

const LIST = listQuery(
  {
    status: {
      column: things.status,
      type: 'enum',
      values: ['draft', 'published'],
      ops: ['eq', 'in'],
      sortable: true,
    },
    title: {
      column: things.title,
      type: 'string',
      ops: ['contains'],
      sortable: true,
    },
    body: { column: things.body, type: 'string', ops: ['contains'] },
    // A money field's currency: its permission is the money field's.
    totalCurrency: {
      column: things.totalCurrency,
      type: 'string',
      ops: ['eq', 'in'],
      reads: ['total'],
    },
    createdAt: {
      column: things.createdAt,
      type: 'datetime',
      ops: ['gte'],
      sortable: true,
    },
  },
  { select: ['id', 'status', 'title', 'body', 'total', 'custom'] },
).extend(
  {
    'custom.region': {
      column: things.custom,
      type: 'string',
      ops: ['eq'],
      sortable: true,
    },
  },
  ['custom.region'],
);

const reads = (raw: Record<string, unknown>) =>
  [...queryReads(LIST.parse(raw))].sort();

describe('queryReads', () => {
  it('names the fields of the flat filters', () => {
    expect(reads({ status: 'draft', 'body.contains': 'x' })).toEqual([
      'body',
      'status',
    ]);
  });

  it('names the fields of the filter tree, at every depth', () => {
    const filter = JSON.stringify({
      and: [
        { field: 'status', op: 'eq', value: 'draft' },
        {
          or: [
            { field: 'title', op: 'contains', value: 'a' },
            { and: [{ field: 'body', op: 'contains', value: 'secret' }] },
          ],
        },
      ],
    });
    expect(reads({ filter })).toEqual(['body', 'status', 'title']);
  });

  it('names the sorted and the selected fields', () => {
    expect(reads({ sort: '-createdAt,title' })).toEqual(['createdAt', 'title']);
    expect(reads({ fields: 'body,total' })).toEqual(['body', 'total']);
  });

  it('maps a custom field to its own name and to custom', () => {
    expect(reads({ 'custom.region': 'eu' })).toEqual([
      'custom',
      'custom.region',
    ]);
    expect(reads({ sort: 'custom.region' })).toEqual([
      'custom',
      'custom.region',
    ]);
    expect(reads({ fields: 'custom.region' })).toEqual([
      'custom',
      'custom.region',
    ]);
  });

  it('maps a currency filter to its money field', () => {
    expect(reads({ 'totalCurrency.in': 'EUR,USD' })).toEqual(['total']);
  });

  it('names nothing for paging alone, and fails closed for a query it did not validate', () => {
    expect(reads({ limit: '10', count: 'true' })).toEqual([]);
    expect(() => queryReads({ limit: 10, status: 'draft' })).toThrow(
      /listQuery\(\) validated/,
    );
    // A copy loses what the check reads: it throws too, never passes.
    expect(() =>
      queryReads({ ...LIST.parse({ 'body.contains': 'x' }) }),
    ).toThrow();
  });

  it('keeps them out of the query: not a key, nor in its JSON', () => {
    const query = LIST.parse({ 'body.contains': 'x' });
    expect(Object.keys(query)).not.toContain('reads');
    expect(JSON.parse(JSON.stringify({ ...query }))).toEqual(
      JSON.parse(JSON.stringify(query)),
    );
    expect(queryReads(query)).toEqual(['body']);
  });

  it('still builds the condition of a filter tree', () => {
    const query = LIST.parse({
      filter: JSON.stringify({ field: 'body', op: 'contains', value: 'x' }),
    });
    expect(LIST.where(query)).toBeDefined();
  });
});

describe('fieldsRead', () => {
  it("is a field's reads, else its name; a dotted name also its object field", () => {
    expect(fieldsRead(LIST.fields, 'title')).toEqual(['title']);
    expect(fieldsRead(LIST.fields, 'totalCurrency')).toEqual(['total']);
    expect(fieldsRead(LIST.fields, 'custom.region')).toEqual([
      'custom.region',
      'custom',
    ]);
    // Not a list field (a `fields=` name): its own name.
    expect(fieldsRead(LIST.fields, 'total')).toEqual(['total']);
  });
});

describe('listQuery: filters and pagination', () => {
  const items = pgTable('things', {
    id: uuid('id').primaryKey(),
    name: text('name'),
    kind: text('kind'),
    ref: uuid('ref'),
    at: timestamp('at', { withTimezone: true }),
    size: integer('size'),
    done: boolean('done'),
  });
  const LIST = listQuery({
    name: {
      column: items.name,
      type: 'string',
      ops: ['eq', 'ne', 'contains', 'startsWith', 'isNull'],
    },
    kind: {
      column: items.kind,
      type: 'enum',
      values: ['a', 'b', 'c'],
      ops: ['eq', 'in'],
    },
    ref: { column: items.ref, type: 'uuid', ops: ['eq', 'in'] },
    at: {
      column: items.at,
      type: 'datetime',
      ops: ['gt', 'gte', 'lt', 'lte'],
    },
    size: { column: items.size, type: 'number', ops: ['gt', 'lte'] },
    done: { column: items.done, type: 'boolean', ops: ['eq'] },
  });
  const dialect = new PgDialect();
  const parse = (query: Record<string, string>) => LIST.schema.safeParse(query);
  const ok = (query: Record<string, string>) => {
    const parsed = parse(query);
    expect(parsed.error?.issues).toBeUndefined();
    return parsed.data as ListQuery;
  };
  const toSql = (query: Record<string, string>) => {
    const where = LIST.where(ok(query), items.id);
    return where ? dialect.sqlToQuery(where) : undefined;
  };
  const issueKeys = (query: Record<string, string>) =>
    parse(query).error!.issues.map((issue) =>
      issue.path.length ? issue.path.join('.') : issue.message,
    );

  it('defaults the limit to 50 and bounds it to 1..100', () => {
    expect(ok({}).limit).toBe(50);
    expect(ok({ limit: '1' }).limit).toBe(1);
    expect(ok({ limit: '100' }).limit).toBe(100);
    for (const limit of ['0', '101', '-1', '2.5', 'abc', '']) {
      expect(parse({ limit }).success, `limit=${limit}`).toBe(false);
    }
  });

  it('takes only a UUID as the cursor, and turns it into id < cursor', () => {
    expect(parse({ cursor: 'abc' }).success).toBe(false);
    expect(parse({ cursor: '1' }).success).toBe(false);
    const cursor = '01a13db4-cd54-7fff-9208-8159d0e51a30';
    const query = toSql({ cursor })!;
    expect(query.sql).toBe('"things"."id" < $1');
    expect(query.params).toEqual([cursor]);
    expect(toSql({})).toBeUndefined();
  });

  it('builds every operator, and no condition for absent keys', () => {
    const ref = '01a13db4-cd54-7fff-9208-8159d0e51a30';
    const query = toSql({
      name: 'x',
      'name.ne': 'y',
      'kind.in': 'a,b',
      ref,
      'at.gt': '2026-01-01T00:00:00Z',
      'at.gte': '2026-01-01T00:00:00+02:00',
      'at.lt': '2026-02-01T00:00:00Z',
      'at.lte': '2026-02-01T00:00:00Z',
      'size.gt': '3',
      'size.lte': '10',
      done: 'false',
    })!;
    expect(query.sql).toContain('"things"."name" = $1');
    expect(query.sql).toContain('"things"."name" <> $2');
    expect(query.sql).toContain('"things"."kind" in ($3, $4)');
    expect(query.sql).toMatch(/"things"\."at" > \$\d/);
    expect(query.sql).toMatch(/"things"\."at" >= \$\d/);
    expect(query.sql).toMatch(/"things"\."at" < \$\d/);
    expect(query.sql).toMatch(/"things"\."at" <= \$\d/);
    expect(query.sql).toMatch(/"things"\."size" > \$\d/);
    expect(query.sql).toMatch(/"things"\."done" = \$\d/);
    expect(query.params).toContain(3);
    expect(query.params).toContain(10);
    expect(query.params).toContain(false);
    // A time with an offset is the same instant in UTC.
    expect(query.params).toContain('2025-12-31T22:00:00.000Z');
  });

  it('splits `in` on commas, trims, drops empty items, and needs at least one', () => {
    expect(ok({ 'kind.in': ' a , b ,,c, ' })['kind.in']).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ok({ 'kind.in': 'a' })['kind.in']).toEqual(['a']);
    expect(issueKeys({ 'kind.in': ',' })).toEqual(['kind.in']);
    expect(issueKeys({ 'kind.in': ' , ' })).toEqual(['kind.in']);
    expect(parse({ 'kind.in': '' }).success).toBe(false);
    // Each item is checked by the field's type.
    expect(parse({ 'kind.in': 'a,z' }).success).toBe(false);
    expect(parse({ 'ref.in': 'not-a-uuid' }).success).toBe(false);
    expect(
      parse({ 'kind.in': Array.from({ length: 51 }, () => 'a').join(',') })
        .success,
    ).toBe(false);
  });

  it('reads isNull=true as IS NULL and isNull=false as IS NOT NULL, nothing else', () => {
    expect(toSql({ 'name.isNull': 'true' })!.sql).toBe(
      '("things"."name" is null)',
    );
    expect(toSql({ 'name.isNull': 'false' })!.sql).toBe(
      '("things"."name" is not null)',
    );
    for (const value of ['1', '0', 'yes', 'TRUE', '']) {
      expect(parse({ 'name.isNull': value }).success, value).toBe(false);
    }
  });

  it('checks values by type', () => {
    expect(parse({ ref: 'nope' }).success).toBe(false);
    expect(parse({ kind: 'z' }).success).toBe(false);
    expect(parse({ done: 'yes' }).success).toBe(false);
    expect(parse({ 'at.gte': '2026-01-01' }).success).toBe(false);
    expect(parse({ 'at.gte': 'yesterday' }).success).toBe(false);
    expect(parse({ 'size.gt': 'many' }).success).toBe(false);
    expect(parse({ name: '' }).success).toBe(false);
    expect(parse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(parse({ 'name.contains': '' }).success).toBe(false);
  });

  it('refuses undeclared fields and operators, naming the key; lang is allowed', () => {
    expect(issueKeys({ secret: '1' }).join()).toContain('secret');
    // An operator the field doesn't declare.
    expect(issueKeys({ 'done.in': 'true' }).join()).toContain('done.in');
    expect(issueKeys({ 'name.gt': 'a' }).join()).toContain('name.gt');
    expect(issueKeys({ 'kind.contains': 'a' }).join()).toContain(
      'kind.contains',
    );
    expect(ok({ lang: 'de' }).lang).toBe('de');
    expect(parse({ lang: 'x'.repeat(36) }).success).toBe(false);
  });

  it('escapes %, _ and backslash in contains and startsWith', () => {
    const contains = toSql({ 'name.contains': '50%_off\\now' })!;
    expect(contains.sql).toBe('"things"."name" ilike $1');
    expect(contains.params).toEqual(['%50\\%\\_off\\\\now%']);
    const startsWith = toSql({ 'name.startsWith': '%' })!;
    expect(startsWith.params).toEqual(['\\%%']);
  });

  it('adds a total to the page when one is given', () => {
    expect(
      toPage([{ id: 'a' }], { limit: 2 }, { total: 7, totalCapped: false }),
    ).toEqual({
      items: [{ id: 'a' }],
      nextCursor: null,
      total: 7,
      totalCapped: false,
    });
  });

  it('pages rows fetched with limit + 1', () => {
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `id-${i}` }));
    expect(toPage(rows(3), { limit: 2 })).toEqual({
      items: rows(2),
      nextCursor: 'id-1',
    });
    // Exactly `limit` rows: the end.
    expect(toPage(rows(2), { limit: 2 })).toEqual({
      items: rows(2),
      nextCursor: null,
    });
    expect(toPage([], { limit: 2 })).toEqual({ items: [], nextCursor: null });
  });
});
