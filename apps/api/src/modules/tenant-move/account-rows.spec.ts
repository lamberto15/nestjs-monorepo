import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { tenantTables } from '../../core/tenancy/tenant-tables.js';
import { accountRowTables } from '../../iam/auth/account-rows.js';
import { users } from '../../iam/auth/auth.tables.js';

const SRC = join(import.meta.dirname, '..', '..');
const tableFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tableFiles(join(dir, entry.name))
      : entry.name.endsWith('.tables.ts')
        ? [join(dir, entry.name)]
        : [],
  );

/** Global tables of an account's rows that stay behind when its tenant moves, each with why. */
const STAYS: Record<string, string> = {
  sessions: 'people sign in again on the new server',
  refresh_tokens: 'people sign in again on the new server',
  email_tokens: 'its links point at the old server',
  oidc_logins: 'a sign-in in flight on the old server',
  mfa_failures: "a lockout counter of the old server's sign-ins",
  push_devices:
    "a browser's subscription is bound to the old origin and its VAPID key: it subscribes again",
  messaging_devices:
    'a phone registers its token again when it signs in to the new server',
};

describe("a moving tenant's accounts take their own rows", () => {
  it('every global table that points at an account is declared with movesWithAccount(), or listed as staying', async () => {
    const all = new Set<PgTable>();
    for (const file of tableFiles(SRC)) {
      for (const value of Object.values(await import(file))) {
        if (is(value, PgTable)) all.add(value as PgTable);
      }
    }
    const walled = new Set(tenantTables().map(({ table }) => table));
    const declared = new Set(accountRowTables().map(({ table }) => table));
    const pointing = [...all].filter(
      (table) =>
        table !== users &&
        !walled.has(table) &&
        (getTableConfig(table).foreignKeys.some(
          (key) => key.reference().foreignTable === users,
        ) ||
          getTableConfig(table).columns.some((column) =>
            /(^|_)user_id$/.test(column.name),
          )),
    );
    const unmarked = pointing
      .filter((table) => !declared.has(table))
      .map(getTableName)
      .filter((name) => !(name in STAYS));
    expect(unmarked).toEqual([]);
    // The list keeps up: each entry is a table that exists and is not declared.
    const names = new Set(pointing.map(getTableName));
    expect(Object.keys(STAYS).filter((name) => !names.has(name))).toEqual([]);
    expect(accountRowTables().filter(({ name }) => name in STAYS)).toEqual([]);
    expect(accountRowTables().length).toBeGreaterThan(5);
  });
});
