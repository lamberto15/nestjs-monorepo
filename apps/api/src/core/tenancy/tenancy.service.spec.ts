import { AsyncLocalStorage } from 'node:async_hooks';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import type { Tenant } from './tenancy.tables.js';
import { TENANT_PAGE, Tenancy, TenantRunsFailed } from './tenancy.service.js';
import { currentTenantScope } from './tenant-scope.js';

const id = (n: number) =>
  `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const tenant = (n: number) =>
  ({ id: id(n), slug: `t${n}`, active: true }) as Tenant;

/** A Tenancy over a table of `count` tenants, read a page per query; the queries' SQL kept. */
function walking(count: number) {
  const cls = new ClsService(new AsyncLocalStorage());
  vi.spyOn(ClsServiceManager, 'getClsService').mockReturnValue(cls);
  const all = Array.from({ length: count }, (_, n) => tenant(n));
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: (where: SQL | undefined) => ({
          orderBy: () => ({
            limit: async (limit: number) => {
              queries.push(
                where
                  ? new PgDialect().sqlToQuery(where)
                  : { sql: '', params: [] },
              );
              const start = (queries.length - 1) * limit;
              return all.slice(start, start + limit);
            },
          }),
        }),
      }),
    }),
  };
  const tenancy = new Tenancy(
    cls,
    { tx: db, isTransactionActive: () => false } as never,
    { mode: 'multi' } as never,
  );
  return { tenancy, queries, all };
}

describe('Tenancy.forEachTenant()', () => {
  afterEach(() => vi.restoreAllMocks());

  it('visits every tenant once, a page at a time by id, at most `concurrency` at once, each in its scope', async () => {
    const { tenancy, queries, all } = walking(TENANT_PAGE * 2 + 7);
    let running = 0;
    let most = 0;
    const seen = await tenancy.forEachTenant(
      'test',
      async (t) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setImmediate(resolve));
        running--;
        return currentTenantScope()?.tenantId === t.id;
      },
      { concurrency: 3 },
    );
    expect(seen.size).toBe(all.length);
    expect([...seen.values()].every(Boolean)).toBe(true);
    expect(most).toBe(3);
    expect(queries).toHaveLength(3);
    // Keyset: the second page starts after the first page's last id.
    expect(queries[1]!.params).toContain(all[TENANT_PAGE - 1]!.id);
    expect(queries[2]!.params).toContain(all[TENANT_PAGE * 2 - 1]!.id);
  });

  it('runs the default of 4 at once, and a failure stops no other tenant', async () => {
    const { tenancy } = walking(10);
    let running = 0;
    let most = 0;
    const ran: string[] = [];
    const error = await tenancy
      .forEachTenant('test', async (t) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setImmediate(resolve));
        running--;
        ran.push(t.slug);
        if (t.slug === 't2') throw new Error('boom');
      })
      .catch((caught: unknown) => caught);
    expect(most).toBe(4);
    expect(ran).toHaveLength(10);
    expect(error).toBeInstanceOf(TenantRunsFailed);
    expect((error as Error).message).toMatch(/t2 \(boom\)/);
  });

  it('reads given ids a page of them at a time, and none for an empty list', async () => {
    const { tenancy, queries } = walking(TENANT_PAGE + 1);
    const ids = Array.from({ length: TENANT_PAGE + 1 }, (_, n) => id(n));
    const seen = await tenancy.forEachTenant('test', async () => 1, {
      tenantIds: ids,
    });
    expect(seen.size).toBe(TENANT_PAGE + 1);
    expect(queries).toHaveLength(2);
    expect(queries[1]!.params).toEqual(
      expect.arrayContaining([id(TENANT_PAGE)]),
    );
    queries.length = 0;
    expect(
      (await tenancy.forEachTenant('test', async () => 1, { tenantIds: [] }))
        .size,
    ).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
