import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The indexes of the migrated schema, read from PostgreSQL's catalog: every
 * table of the app and of the generator's fixture (test/fixtures), so a new
 * module or a generated feature is held to the same rules. The test data is
 * a few rows, where a missing index never shows: this is what catches one.
 * Raw SQL: the catalogs have no Drizzle API (and specs are outside the rule).
 */
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await client.connect();
});

afterAll(() => client.end());

describe('the indexes', () => {
  it('cover every foreign key', async () => {
    // Covered: an index (not partial) whose leading columns are the key's,
    // in any order; for a tenant key (tenant_id, x), also one leading with
    // x, a UUID that finds the rows alone. Without one, deleting or
    // updating the referenced row (a tenant's delete cascades into every
    // tenant table) reads the whole table, inside that transaction.
    const { rows } = await client.query<{ key: string }>(`
      with fk as (
        select c.conrelid, c.conname, c.conkey,
               array(select a.attnum from unnest(c.conkey) k(n)
                     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n
                     where a.attname <> 'tenant_id') as own
        from pg_constraint c
        where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      )
      select format('%s.%s (%s)', fk.conrelid::regclass, fk.conname,
               (select string_agg(attname, ', ') from pg_attribute
                where attrelid = fk.conrelid and attnum = any(fk.conkey))) as key
      from fk
      where not exists (
        select 1 from pg_index i
        where i.indrelid = fk.conrelid and i.indpred is null and (
          ((i.indkey::int2[])[0:cardinality(fk.conkey) - 1] @> fk.conkey
           and (i.indkey::int2[])[0:cardinality(fk.conkey) - 1] <@ fk.conkey)
          or (cardinality(fk.own) between 1 and cardinality(fk.conkey) - 1
              and (i.indkey::int2[])[0] = any(fk.own))))
      order by 1`);
    expect(
      rows.map((row) => row.key),
      'Add an index on these keys in their table file (index(…).on(…)), then pnpm db:generate',
    ).toEqual([]);
  });

  it('hold none that another already serves', async () => {
    // Redundant: a plain index whose columns lead another of the same
    // kind. It slows every write and serves no query the other doesn't.
    const { rows } = await client.query<{ redundant: string }>(`
      select format('%s (served by %s)', a.indexrelid::regclass, b.indexrelid::regclass) as redundant
      from pg_index a
      join pg_index b on b.indrelid = a.indrelid and b.indexrelid <> a.indexrelid
      join pg_class ca on ca.oid = a.indexrelid
      join pg_class cb on cb.oid = b.indexrelid
      where ca.relnamespace = 'public'::regnamespace
        and not a.indisunique and a.indpred is null and b.indpred is null
        and a.indexprs is null and b.indexprs is null and ca.relam = cb.relam
        and cardinality(a.indkey::int2[]) <= cardinality(b.indkey::int2[])
        and (b.indkey::int2[])[0:cardinality(a.indkey::int2[]) - 1] = a.indkey::int2[]
      order by 1`);
    expect(
      rows.map((row) => row.redundant),
      'Drop the redundant index from its table file, then pnpm db:generate',
    ).toEqual([]);
  });
});
