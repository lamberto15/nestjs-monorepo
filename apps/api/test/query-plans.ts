import pg from 'pg';

/**
 * Query plans for the tests: what the app's own statements cost on a table
 * of realistic size, where a few rows never show a missing index. A test
 * seeds the tables (many rows of other tenants), `analyze`s them, runs the
 * work through `captured()`, then expects `fullScans()` to be empty.
 * Custom: PostgreSQL's auto_explain needs a superuser to load, and the
 * statements are the app's (Drizzle's text and values), never copies.
 */
export interface Statement {
  text: string;
  values: unknown[];
  /** The role it ran as: the app's (bound to a tenant) or maintenance. */
  user: string;
  /** The tenant the transaction was bound to ('' outside every tenant). */
  tenantId: string;
}

const BINDING = /set_config\('app\.tenant_id', '([^']*)', true\)/;
const PLANNED = /^\s*(select|with|update|delete)\b/i;

/** The statements of the `captured()` running now, if one is. */
let recording: Statement[] | undefined;
const tenantOf = new WeakMap<pg.Client, string>();

// Installed when this file is imported, before the app boots: a pool's
// clients bind `query` when they connect (the tenant binding, the metrics),
// so a later patch would miss them.
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const [config, values] = args as [unknown, unknown];
  const text =
    typeof config === 'string'
      ? config
      : ((config as { text?: string } | null)?.text ?? '');
  const bound = BINDING.exec(text);
  if (bound) {
    tenantOf.set(this, bound[1]!);
  } else if (/^\s*(commit|rollback)\b/i.test(text)) {
    tenantOf.delete(this);
  } else if (recording && PLANNED.test(text)) {
    recording.push({
      text,
      values: Array.isArray(values)
        ? values
        : ((config as { values?: unknown[] }).values ?? []),
      user: this.user ?? '',
      tenantId: tenantOf.get(this) ?? '',
    });
  }
  return (original as (...a: unknown[]) => unknown).apply(this, args);
} as typeof original;

/** The reads and writes `work` sends to PostgreSQL, with their tenant. */
export async function captured(work: () => Promise<unknown>) {
  const statements: Statement[] = [];
  recording = statements;
  try {
    await work();
  } finally {
    recording = undefined;
  }
  return statements;
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

const scanned = (node: PlanNode): string[] => [
  ...(node['Node Type'] === 'Seq Scan' && node['Relation Name']
    ? [node['Relation Name']]
    : []),
  ...(node.Plans ?? []).flatMap(scanned),
];

/**
 * The statements whose plan reads a whole table of `large` (each as the
 * role and in the tenant it ran in): `<table>: <statement>`. `urls` maps a
 * role to a URL to plan as (process.env.DATABASE_URL's and
 * DATABASE_MAINTENANCE_URL's in an e2e test).
 */
export async function fullScans(
  statements: Statement[],
  large: readonly string[],
  urls: readonly string[],
) {
  const clients = new Map<string, pg.Client>();
  for (const url of urls) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.set(client.user!, client);
  }
  try {
    const found = new Set<string>();
    for (const statement of statements) {
      const client = clients.get(statement.user);
      if (!client) {
        throw new Error(`No URL to plan as ${statement.user}.`);
      }
      await client.query('begin');
      try {
        await client.query(`select set_config('app.tenant_id', $1, true)`, [
          statement.tenantId,
        ]);
        const { rows } = await client.query<{
          'QUERY PLAN': [{ Plan: PlanNode }];
        }>(`explain (format json) ${statement.text}`, statement.values);
        for (const table of scanned(rows[0]!['QUERY PLAN'][0].Plan)) {
          if (large.includes(table)) {
            found.add(`${table}: ${statement.text.replace(/\s+/g, ' ')}`);
          }
        }
      } finally {
        await client.query('rollback');
      }
    }
    return [...found];
  } finally {
    await Promise.all([...clients.values()].map((client) => client.end()));
  }
}
