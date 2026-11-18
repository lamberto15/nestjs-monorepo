import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { secretColumnsOf } from '../../core/database/secret-columns.js';
import { tenantTables } from '../../core/tenancy/tenant-tables.js';
import { pagingKey } from '../../core/tenancy/table-paging.js';

const SRC = join(import.meta.dirname, '..', '..');

const tableFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tableFiles(join(dir, entry.name))
      : entry.name.endsWith('.tables.ts')
        ? [join(dir, entry.name)]
        : [],
  );

describe('a tenant export pages every table that names a tenant', () => {
  it('finds a key in each: a primary key, or a unique index on columns never null', async () => {
    for (const file of tableFiles(SRC)) await import(file);
    const without = tenantTables()
      .filter(({ table }) => pagingKey(getTableConfig(table)).length === 0)
      .map(({ name }) => name);
    expect(tenantTables().length).toBeGreaterThan(10);
    expect(without).toEqual([]);
  });
});

/** Names that look like a credential or a secret. */
const SUSPICIOUS = /hash|secret|token|verifier|password|private|credential/i;
/** Tenant tables' columns that match SUSPICIOUS and hold no secret, each with why. */
const NOT_SECRET: Record<string, string> = {
  'ai_runs.inputTokens': 'a count',
  'ai_runs.outputTokens': 'a count',
  'auth_policies.passwordMinLength': 'a rule',
  'auth_policies.passwordHistory': 'a rule',
  'documents.runToken': "a render's lease id",
  'incoming_webhook_senders.previousSecretExpiresAt': 'a time',
  'sso_connections.tokenEndpoint': 'a URL',
  'sso_connections.tokenEndpointAuthMethod': 'a method name',
  'sso_domains.verificationToken': 'published in DNS',
  'tenant_domains.verificationToken': 'published in DNS',
};

describe('a tenant export leaves secrets out', () => {
  it('every tenant column named like a secret is declared with secretColumns(), or known not to be one', async () => {
    for (const file of tableFiles(SRC)) await import(file);
    const unmarked = tenantTables().flatMap(({ name, table }) => {
      const secret = secretColumnsOf(table);
      return Object.keys(getColumns(table))
        .filter((property) => SUSPICIOUS.test(property))
        .filter((property) => !secret.has(property))
        .map((property) => `${name}.${property}`)
        .filter((column) => !(column in NOT_SECRET));
    });
    expect(unmarked).toEqual([]);
    // The list keeps up: each entry is a column that exists.
    const columns = new Set(
      tenantTables().flatMap(({ name, table }) =>
        Object.keys(getColumns(table)).map((property) => `${name}.${property}`),
      ),
    );
    expect(Object.keys(NOT_SECRET).filter((c) => !columns.has(c))).toEqual([]);
  });
});
