import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import {
  isTest,
  levelOf,
  moduleGraph,
  moduleOf,
  sources,
} from '../test/module-graph.js';

/**
 * The dependency rule (root AGENTS.md, rule 4), checked on the imports
 * themselves (test/module-graph.ts): `core` ← `iam` ← `modules` ←
 * `features`, and among the modules of one level no cycle. `core` is one
 * unit, always there together (its database and tenancy parts know each
 * other), so cycles are looked for above it. Tests are left out: a test may
 * boot what it needs.
 */
const edges = moduleGraph(import.meta.dirname);

describe('the module graph', () => {
  it('never imports a higher level', () => {
    const upward = [...edges].flatMap(([from, targets]) =>
      [...targets]
        .filter((to) => levelOf(to) > levelOf(from))
        .map((to) => `${from} -> ${to}`),
    );
    expect(upward).toEqual([]);
  });

  it('has no cycle', () => {
    const cycles: string[] = [];
    const done = new Set<string>();
    const walk = (module: string, path: string[]) => {
      const at = path.indexOf(module);
      if (at >= 0) {
        cycles.push([...path.slice(at), module].join(' -> '));
        return;
      }
      if (done.has(module)) return;
      for (const next of edges.get(module) ?? []) {
        if (levelOf(next) > 0) walk(next, [...path, module]);
      }
      done.add(module);
    };
    for (const module of edges.keys()) walk(module, []);
    expect(cycles).toEqual([]);
  });
});

/**
 * The layers (root AGENTS.md, rule 7): queries live in repositories.
 *
 * - No controller imports Drizzle or a `*.tables.ts`.
 * - In every module, nothing but a repository, a table file or the module's
 *   wiring imports `drizzle-orm` or `@nestjs/drizzle`: services, jobs and
 *   handlers ask a repository. A file that must keep a query (a package's
 *   store, a list declaration, a helper other repositories build on) says
 *   why in MAY_QUERY; the records engine and tenant move are QUERY_ENGINES.
 */
/** Folders whose queries are the engine itself, not a module's own. */
const QUERY_ENGINES: Record<string, string> = {
  'modules/records':
    "the records engine: RecordStore is every record feature's repository",
  'modules/tenant-move':
    'a table-agnostic export and import: each query runs on a table chosen at runtime, beside its metadata reads',
};

const LIST_DECLARATION =
  "a list's declaration: its filters, sorts and subqueries are SQL over its table, as the list helpers take them";

const MAY_QUERY: Record<string, string> = {
  // core: the data layer and the helpers every repository builds on.
  'core/tenancy/row-level-security.ts':
    "the isolation strategy: the tenant wall's policies, pool and provisioning",
  'core/tenancy/tenant-tables.ts': 'the table builders of every tables file',
  'core/tenancy/tenant-isolation.ts':
    "the isolation seam's interface (Drizzle types only)",
  'core/tenancy/table-paging.ts':
    'a key-paging helper over any table, for tenant export and move',
  'core/database/migrations.ts':
    'applies the migrations on a connection of its own',
  'core/database/database.readiness.ts': "the pool's readiness probe",
  'core/database/database.ts': 'the Database type over the driver',
  'core/database/columns.ts': 'column builders for every tables file',
  'core/database/secret-columns.ts':
    "reads a table's columns to find its secret ones; no query",
  'core/encryption/encryption.service.ts':
    "builds a blind-index condition for its callers' queries; no query",
  'core/encryption/encrypted-columns.ts':
    'the encrypted column builders and their table metadata',
  'core/encryption/reencryption.service.ts':
    "re-encrypts every discovered encrypted column on the database it is given (a tenant's)",
  'core/locks/locks.store.ts': "the store of @nestjs/locks' interface",
  'core/idempotency/idempotency.store.ts':
    "the store of @nestjs/idempotency's interface",
  'core/metrics/database-pool.metrics.ts':
    "observes the driver's pool; no query",
  'core/http/list-query.ts': 'builds list filters for other repositories',
  'core/http/list-sort.ts': 'builds list sorts for other repositories',
  'core/http/pagination.ts': 'builds cursors for other repositories',
  // iam
  'iam/audit/audit-run.ts':
    'the audit-run targets subquery that other queries embed',
  'iam/audit-log/audit.lists.ts': LIST_DECLARATION,
  'iam/holds/holds.lists.ts': LIST_DECLARATION,
  'iam/tenants/tenants.lists.ts': LIST_DECLARATION,
  'iam/access/access.lists.ts': LIST_DECLARATION,
  'iam/organization/memberships.ts':
    'SQL conditions and subqueries that other repositories embed',
  'iam/organization/tree.ts':
    "the unit tree's query helpers, run on the caller's database and shared with SCIM",
  'iam/organization/unit-conditions.ts': 'a column type only',
  'iam/access/access.service.ts':
    "derives each CASL condition's SQL filter, so a condition is written once (rule 5)",
  'iam/access/permissions.ts': 'a column type only',
  'iam/access/permission-catalog.ts':
    'reads table columns to check declared fields; no query',
  'iam/access/unit-directory.ts': "the extension point's SQL types only",
  'iam/account/account.stores.ts':
    "the stores of @nestjs/authentication's interfaces (two-factor, magic links, OIDC logins, email links)",
  'iam/auth/drizzle-authentication.store.ts':
    "the store of @nestjs/authentication's interface",
  'iam/auth/account-rows.ts':
    'the movesWithAccount() registry reads table metadata; no query',
  'iam/auth/token-session.ts':
    'SQL expressions over refresh token claims that the store and repositories embed',
  'iam/sso/scim/scim-filter.ts':
    'translates a SCIM filter into the where clause its repositories run; no query',
  // modules
  'modules/webhooks/webhook-store.view.ts':
    "the package's store tables, declared as a tables file declares its own",
  'modules/webhooks/webhook.transport.ts':
    "the package builds the transport in its own module, where WebhooksRepository isn't provided",
  'modules/ops/outbox-store.view.ts':
    "the package's store tables, declared as a tables file declares its own",
  'modules/custom-fields/custom-field.list.ts': LIST_DECLARATION,
  'modules/deliverability/deliverability.lists.ts': LIST_DECLARATION,
  'modules/tags/tags.list.ts': LIST_DECLARATION,
  'modules/templates/template.list.ts': LIST_DECLARATION,
  'modules/views/view.list.ts': LIST_DECLARATION,
  'modules/notifications/notifications.lists.ts': LIST_DECLARATION,
  'modules/approvals/approvals.list.ts':
    "a list's declaration, and the request conditions (assigned to, decided by, takes part in) its filters and the repository share",
  'modules/attachments/attachments.quota.ts':
    "defineQuota()'s count is handed the database by the quotas module",
  'modules/money/money.columns.ts': 'a column type',
  'modules/retention/retention.rules.ts':
    'the declaration types (a table, its age column, a condition) modules pass to forFeature()',
  'modules/sequences/sequences.record.ts':
    'declares a column, and reads a record table chosen at runtime in the forRecord() module',
  'modules/fields/field.ts': 'column and index declarations; no query',
  'modules/fields/fields.ts': 'column and index declarations; no query',
  'modules/fields/fields.list.ts': 'column and index declarations; no query',
};

const isDrizzle = (from: string) =>
  from === '@nestjs/drizzle' ||
  from === 'drizzle-orm' ||
  from.startsWith('drizzle-orm/');

/** Every module specifier a file imports, packages included. */
const specifiersOf = (file: string) =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /(?:from|import)\s*\(?\s*'([^']+)'/g,
    ),
  ].map(([, from]) => from!);

const holdsItsOwnQueries = (module: string | undefined) =>
  module !== undefined && !(module in QUERY_ENGINES);

describe('the layers', () => {
  const src = import.meta.dirname;
  const files = sources(src)
    .filter((file) => !isTest(file))
    .map((file) => ({ file, path: relative(src, file) }));

  it('keeps queries out of controllers', () => {
    const found = files
      .filter(({ path }) => path.endsWith('.controller.ts'))
      .flatMap(({ file, path }) =>
        specifiersOf(file)
          .filter((from) => isDrizzle(from) || from.endsWith('.tables.js'))
          .map((from) => `${path} -> ${from}`),
      );
    expect(found).toEqual([]);
  });

  it('keeps queries in repositories', () => {
    const found = files
      .filter(
        ({ file, path }) =>
          holdsItsOwnQueries(moduleOf(src, file)) &&
          !/\.(repository|tables|module)\.ts$/.test(path) &&
          !(path in MAY_QUERY),
      )
      .flatMap(({ file, path }) =>
        specifiersOf(file)
          .filter(isDrizzle)
          .map((from) => `${path} -> ${from}`),
      );
    expect(found).toEqual([]);
  });

  it('lists only files that exist', () => {
    const missing = Object.keys(MAY_QUERY).filter(
      (path) => !files.some((file) => file.path === path),
    );
    expect(missing).toEqual([]);
  });
});
