import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import { bigint, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { at } from '../../core/database/columns.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { tenantTables } from '../../core/tenancy/tenant-tables.js';
import { accountRowTables } from '../../iam/auth/account-rows.js';
import { users } from '../../iam/auth/auth.tables.js';
import {
  decodeRow,
  encodeRow,
  insertOrder,
  outsideReferences,
  selfReference,
} from './move-rows.js';

const SRC = join(import.meta.dirname, '..', '..');
const tableFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tableFiles(join(dir, entry.name))
      : entry.name.endsWith('.tables.ts')
        ? [join(dir, entry.name)]
        : [],
  );

const parents = pgTable('parents', {
  id: uuid('id').primaryKey(),
  at: at('at'),
  amount: bigint('amount', { mode: 'bigint' }),
});
const children = pgTable('children', {
  id: uuid('id').primaryKey(),
  parentId: uuid('parent_id').references(() => parents.id),
  upId: uuid('up_id').references((): never => children.id as never),
  note: text('note'),
});

describe('rows of a move', () => {
  it('gives back a point in time from its column, and every other value as JSON has it', () => {
    const row = { id: 'a', at: new Date('2026-11-19T01:02:03.456Z') };
    const back = decodeRow(parents, JSON.parse(encodeRow(row)));
    expect(back).toEqual(row);
    expect(back.at).toBeInstanceOf(Date);
    expect(decodeRow(parents, { id: 'a', at: null })).toEqual({
      id: 'a',
      at: null,
    });
  });

  it('gives back a 64-bit integer (money) from its column', () => {
    const row = { id: 'a', amount: 9_007_199_254_740_993n };
    const line = encodeRow(row);
    expect(line).toBe('{"id":"a","amount":"9007199254740993"}\n');
    expect(decodeRow(parents, JSON.parse(line))).toEqual(row);
  });

  it('refuses a property the table lacks: an archive of another schema', () => {
    expect(() => decodeRow(parents, { id: 'a', gone: 1 })).toThrow(
      'parents has no column gone',
    );
  });

  it('orders tables after the ones they point at, and finds a key to the same table', () => {
    const order = insertOrder([{ table: children }, { table: parents }]);
    expect(order.map(({ table }) => getTableName(table))).toEqual([
      'parents',
      'children',
    ]);
    expect(selfReference(children)).toEqual({ child: 'upId', parent: 'id' });
    expect(selfReference(parents)).toBeUndefined();
    expect(outsideReferences(children, new Set([children]))).toEqual([
      expect.objectContaining({ table: parents, properties: ['parentId'] }),
    ]);
  });

  it('orders every table of the app: the tenant and the accounts first, no cycle', async () => {
    for (const file of tableFiles(SRC)) await import(file);
    const entries = [
      { table: tenants },
      { table: users },
      ...accountRowTables(),
      ...tenantTables(),
    ];
    const order = insertOrder(entries).map(({ table }) => table);
    for (const { table } of accountRowTables()) {
      expect(order.indexOf(table)).toBeGreaterThan(order.indexOf(users));
    }
    for (const { table } of tenantTables()) {
      expect(order.indexOf(table)).toBeGreaterThan(order.indexOf(tenants));
    }
    expect(order).toHaveLength(new Set(entries.map((e) => e.table)).size);
  });
});
