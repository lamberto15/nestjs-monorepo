import { sql, type SQL } from 'drizzle-orm';
import {
  type AnyPgColumn,
  getTableConfig,
  PgDialect,
  pgPolicy,
  type PgPolicy,
  pgTable,
  uuid,
} from 'drizzle-orm/pg-core';
import pg, { type ClientBase, escapeIdentifier } from 'pg';
import {
  assertTenantId,
  currentTenantScope,
  type TenantScope,
} from './tenant-scope.js';
import type { TenantIsolation, TenantRows } from './tenant-isolation.js';

/** The transaction-local setting the policies read. */
const SETTING = 'app.tenant_id';

/** The scope's tenant, null when unset or empty; read once per statement (an InitPlan). */
const currentTenant = sql.raw(
  `(select nullif(current_setting('${SETTING}', true), '')::uuid)`,
);

/**
 * The four policies of a tenant table: its rows are read and written in
 * their own tenant alone (an update may not move a row to another: its
 * WITH CHECK reads the same setting). An unset or empty setting matches no
 * row, so a connection without a tenant reads and writes nothing. No bypass
 * clause: cross-tenant work runs as the maintenance role (BYPASSRLS).
 */
function tenantPolicies(
  table: string,
  tenantId: AnyPgColumn,
  rows: TenantRows = 'tenant',
): PgPolicy[] {
  if (rows === 'global') {
    // A global table naming a tenant: no wall, declared as such so the
    // check at migrate tells it from a tenant table missing its own.
    return [
      pgPolicy(`${table}_global`, {
        for: 'all',
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ];
  }
  // Rows of no tenant ('tenant-or-none'): read and written only where the
  // context has no tenant either, so no tenant sees an account's own rows.
  const own =
    rows === 'tenant'
      ? sql`(${tenantId} = ${currentTenant})`
      : sql`((${tenantId} = ${currentTenant}) or (${tenantId} is null and ${currentTenant} is null))`;
  return [
    pgPolicy(`${table}_tenant_select`, { for: 'select', using: own }),
    pgPolicy(`${table}_tenant_insert`, { for: 'insert', withCheck: own }),
    pgPolicy(`${table}_tenant_update`, {
      for: 'update',
      using: own,
      withCheck: own,
    }),
    pgPolicy(`${table}_tenant_delete`, { for: 'delete', using: own }),
  ];
}

/**
 * The statement that binds a transaction to a scope: `set_config(…, true)`
 * is SET LOCAL, gone at commit or rollback, so it never stays on a pooled
 * connection. A literal, so it rides in `begin`'s round trip; only a checked
 * UUID (TenantScope) ever goes in it. Every transaction gets it, an empty
 * value without a tenant, so none can inherit another's.
 */
export function bindingStatement(scope: TenantScope | undefined) {
  const tenantId = scope?.tenantId ? assertTenantId(scope.tenantId) : '';
  return `select set_config('${SETTING}', '${tenantId}', true)`;
}

const BEGIN = /^\s*(?:begin|start\s+transaction)\b/i;
const ONE_STATEMENT = /^[^;]*;?\s*$/;

type QueryArgs = [config: unknown, values?: unknown, callback?: unknown];

/**
 * Wraps a new connection's query(): a `begin` is sent with the binding of
 * the current scope, in the same round trip (a statement without
 * parameters goes by the simple protocol, which takes several).
 */
function bindTransactions(client: pg.PoolClient) {
  const query = client.query.bind(client) as (...args: QueryArgs) => unknown;
  (client as { query: unknown }).query = (...args: QueryArgs) => {
    const [config, values, callback] = args;
    const text =
      typeof config === 'string'
        ? config
        : (config as { text?: unknown } | null)?.text;
    if (typeof text !== 'string' || !BEGIN.test(text)) {
      return query(...args);
    }
    if (
      !ONE_STATEMENT.test(text) ||
      (Array.isArray(values) && values.length > 0)
    ) {
      const error = new Error(
        'A transaction must begin with a statement of its own (tenancy binds it to its tenant).',
      );
      const done = [values, callback].find((arg) => typeof arg === 'function');
      if (done) {
        queueMicrotask(() => (done as (error: Error) => void)(error));
        return undefined;
      }
      return Promise.reject(error);
    }
    const bound = `${text.replace(/;\s*$/, '')}; ${bindingStatement(currentTenantScope())}`;
    return query(
      typeof config === 'string'
        ? bound
        : { ...(config as object), text: bound },
      values,
      callback,
    );
  };
}

const insideTransaction = (client: pg.PoolClient) => {
  const status = client.getTransactionStatus();
  return status === 'T' || status === 'E';
};

/**
 * Custom, not a package's: neither node-postgres, Drizzle nor
 * @nestjs-cls/transactional has a per-transaction hook for a setting, and
 * every query must carry the scope of its context: a transaction's (the
 * transaction host's, or a `db.transaction()`), and one outside any
 * (`@InjectDrizzle()`, `@InjectTransaction()` outside `@Transactional()`).
 *
 * - **Every transaction begins bound** to its context's scope
 *   (bindingStatement()), so the binding ends with it.
 * - **A query outside a transaction, in a tenant's scope, gets one of its
 *   own**: `begin` (bound), the query, `commit`. Without a tenant it goes
 *   straight through, unbound: a tenant table shows no row and takes no write.
 * - **A connection given back inside a transaction is closed**, never
 *   reused: its binding would carry over into the next use.
 * - **Cross-tenant scope goes to the maintenance role's pool** (BYPASSRLS),
 *   and is refused without one: no setting of the app role opens every tenant.
 */
class TenantPool extends pg.Pool {
  constructor(
    config: pg.PoolConfig,
    private readonly acrossTenants?: pg.Pool,
  ) {
    super(config);
    this.on('connect', bindTransactions);
    this.on('release', (_error, client) => {
      if (insideTransaction(client)) {
        void client.end();
      }
    });
    // A dropped idle connection is the pool's to replace, not a crash.
    this.acrossTenants?.on('error', () => undefined);
  }

  override connect(...args: unknown[]): never {
    const pool = currentTenantScope()?.acrossTenants
      ? this.maintenance()
      : undefined;
    return pool
      ? (pool.connect as (...a: unknown[]) => never)(...args)
      : (super.connect as (...a: unknown[]) => never)(...args);
  }

  override query(...args: unknown[]): never {
    const [config, values, callback] = args as QueryArgs;
    const scope = currentTenantScope();
    if (scope?.acrossTenants) {
      return (this.maintenance().query as (...a: unknown[]) => never)(...args);
    }
    if (
      !scope?.tenantId ||
      typeof values === 'function' ||
      typeof callback === 'function'
    ) {
      // No tenant (or the callback form, which Drizzle never uses): unbound.
      return (super.query as (...a: unknown[]) => never)(...args);
    }
    return this.inTransaction(config, values) as never;
  }

  override async end() {
    await Promise.all([super.end(), this.acrossTenants?.end()]);
  }

  private async inTransaction(config: unknown, values: unknown) {
    const client = await (this.connect() as unknown as Promise<pg.PoolClient>);
    let broken: Error | undefined;
    try {
      await client.query('begin');
      try {
        const result = await client.query(config as string, values as []);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback').catch((rollback: Error) => {
          broken = rollback;
        });
        throw error;
      }
    } finally {
      client.release(broken);
    }
  }

  private maintenance() {
    if (!this.acrossTenants) {
      throw new Error(
        'Work across every tenant needs the maintenance role, and this process has none: set DATABASE_MAINTENANCE_URL (core/tenancy/README.md).',
      );
    }
    return this.acrossTenants;
  }
}

/**
 * The runtime role must be bound by the policies: a superuser or a role
 * with BYPASSRLS reads every tenant whatever the setting. Refused at start.
 */
async function assertBoundByPolicies(pool: pg.Pool) {
  const { rows } = await pool.query<{
    role: string;
    superuser: boolean;
    bypass: boolean;
  }>(
    'select rolname as role, rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = current_user',
  );
  const role = rows[0];
  if (!role || role.superuser || role.bypass) {
    throw new Error(
      `DATABASE_URL connects as "${role?.role}", a ${role?.superuser ? 'superuser' : 'role with BYPASSRLS'}: row-level security wouldn't bind it. Give the app a role of its own (core/database/README.md, "Roles").`,
    );
  }
}

/** A policy as PostgreSQL holds it, its expressions deparsed. */
type LivePolicy = {
  name: string;
  command: string;
  permissive: boolean;
  roles: string[];
  using: string | null;
  withCheck: string | null;
};

/** Every policy of the tables in `namespace` (an SQL expression), by table and name. */
async function policiesIn(client: ClientBase, namespace: string) {
  const { rows } = await client.query<LivePolicy & { table: string }>(
    `select c.relname as table, p.polname as name, p.polcmd as command, p.polpermissive as permissive,
            array(select case when r = 0 then 'public' else pg_get_userbyid(r)::text end
                  from unnest(p.polroles) r order by 1) as roles,
            pg_get_expr(p.polqual, p.polrelid) as using,
            pg_get_expr(p.polwithcheck, p.polrelid) as "withCheck"
     from pg_policy p join pg_class c on c.oid = p.polrelid
     where c.relnamespace = ${namespace}
     order by 1, 2`,
  );
  const byTable = new Map<string, Map<string, LivePolicy>>();
  for (const { table, ...policy } of rows) {
    const policies = byTable.get(table) ?? new Map<string, LivePolicy>();
    policies.set(policy.name, policy);
    byTable.set(table, policies);
  }
  return byTable;
}

/**
 * The policies every tenant table should have, as PostgreSQL normalizes
 * them: created on empty temporary copies of the tables (same names, so
 * the column references deparse the same), read back, rolled back.
 * Formatting can't fail the comparison; a different expression can.
 */
async function expectedPolicies(
  client: ClientBase,
  tables: { name: string; rows: TenantRows }[],
) {
  const dialect = new PgDialect();
  const render = (expression: SQL | undefined) =>
    expression && dialect.sqlToQuery(expression).sql;
  await client.query('savepoint tenant_wall_probe');
  try {
    for (const { name: table, rows } of tables) {
      const name = escapeIdentifier(table);
      await client.query(
        `create temporary table pg_temp.${name} (like public.${name})`,
      );
      const declared = getTableConfig(
        pgTable(table, { tenantId: uuid('tenant_id') }, (t) =>
          tenantPolicies(table, t.tenantId, rows),
        ),
      ).policies;
      for (const policy of declared) {
        const using = render(policy.using);
        const withCheck = render(policy.withCheck);
        await client.query(
          `create policy ${escapeIdentifier(policy.name)} on pg_temp.${name}
             as permissive for ${policy.for} to public
             ${using ? `using (${using})` : ''}
             ${withCheck ? `with check (${withCheck})` : ''}`,
        );
      }
    }
    return await policiesIn(client, 'pg_my_temp_schema()');
  } finally {
    await client.query('rollback to savepoint tenant_wall_probe');
  }
}

const POLICY_PARTS = [
  'command',
  'permissive',
  'roles',
  'using',
  'withCheck',
] as const;

/**
 * Every table with a `tenant_id` has row-level security enabled and
 * forced, and exactly the policies its declaration gives, with no other
 * permissive policy: a table declared without tenantTable() or
 * globalTable(), or a policy edited by hand (`ALTER POLICY … USING
 * (true)`), stops the migration. Which declaration a table has is read
 * from the database: a `<table>_global` policy is globalTable()'s, a
 * `tenant_id` that may be null is tenantTable()'s `nullRows`, any other
 * is a tenant table's. Custom: drizzle-kit compares policies with its
 * snapshot, not with the database.
 */
async function assertWall(client: ClientBase) {
  const { rows } = await client.query<{
    name: string;
    enabled: boolean;
    forced: boolean;
    required: boolean;
  }>(
    `select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
            a.attnotnull as required
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p')
     order by 1`,
  );
  if (rows.length === 0) {
    return;
  }
  const live = await policiesIn(client, `'public'::regnamespace`);
  const wanted = await expectedPolicies(
    client,
    rows.map((row) => ({
      name: row.name,
      rows: live.get(row.name)?.has(`${row.name}_global`)
        ? ('global' as const)
        : row.required
          ? ('tenant' as const)
          : ('tenant-or-none' as const),
    })),
  );
  const problems = rows.flatMap((row) => {
    const found = live.get(row.name) ?? new Map<string, LivePolicy>();
    const want = wanted.get(row.name) ?? new Map<string, LivePolicy>();
    const wrong = [
      !row.enabled && 'row-level security off',
      !row.forced && 'not forced',
      ...[...want.values()].flatMap((policy) => {
        const actual = found.get(policy.name);
        if (!actual) {
          return [`missing policy ${policy.name}`];
        }
        const differs = POLICY_PARTS.filter(
          (part) =>
            JSON.stringify(actual[part]) !== JSON.stringify(policy[part]),
        );
        return differs.length
          ? [`policy ${policy.name} differs (${differs.join(', ')})`]
          : [];
      }),
      ...[...found.values()]
        .filter((policy) => policy.permissive && !want.has(policy.name))
        .map((policy) => `unexpected permissive policy ${policy.name}`),
    ].filter(Boolean);
    return wrong.length ? [`${row.name} (${wrong.join(', ')})`] : [];
  });
  if (problems.length > 0) {
    throw new Error(
      `Tenant tables without their wall: ${problems.join('; ')}. Declare them with tenantTable() (or globalTable()) and change them only there (pnpm db:generate), never by hand (core/tenancy/README.md).`,
    );
  }
}

/** Row-level security: the isolation of this app (tenant-isolation.ts). */
export const rowLevelSecurity: TenantIsolation = {
  tableWall: tenantPolicies,

  async connect({ app, acrossTenants }) {
    const pool = new TenantPool(
      app,
      // A few connections: maintenance runs one sweep at a time.
      acrossTenants && new pg.Pool({ ...acrossTenants, max: 3 }),
    );
    try {
      await assertBoundByPolicies(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
    return pool;
  },

  async secure(owner, log) {
    // drizzle-kit emits ENABLE ROW LEVEL SECURITY with the policies, never
    // FORCE, without which the tables' owner would pass them.
    const { rows } = await owner.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity and not c.relforcerowsecurity
       order by 1`,
    );
    for (const { name } of rows) {
      await owner.query(
        `alter table public.${escapeIdentifier(name)} force row level security`,
      );
      log(`Row-level security forced on ${name}.`);
    }
    await assertWall(owner);
  },

  // A tenant is a row of `tenants`: its rows need no storage of their own.
  provision: () => Promise.resolve(),
};
