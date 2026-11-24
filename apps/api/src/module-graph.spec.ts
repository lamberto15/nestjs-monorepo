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
 * - No controller imports Drizzle or a `*.tables.ts`, except the ones in
 *   CONTROLLERS_NOT_YET, which a module's conversion removes from the list.
 * - In a folder of CONVERTED, nothing but a repository, a table file or the
 *   module's wiring imports `drizzle-orm` or `@nestjs/drizzle`: services,
 *   jobs and handlers ask a repository. A conversion adds its folder here;
 *   a file that must keep a query says why in MAY_QUERY.
 *
 * shortcut: services are checked only in CONVERTED folders while the others
 * are converted; when every folder is listed, drop the list and check all.
 */
const CONVERTED = ['iam/api-clients', 'modules/webhooks'];

const CONTROLLERS_NOT_YET = [
  'iam/audit-log/audit.controller.ts',
  'iam/organization/organization.controller.ts',
  'modules/branding/branding.controller.ts',
];

const MAY_QUERY: Record<string, string> = {
  'modules/webhooks/webhook-store.view.ts':
    "the package's store tables, declared as a tables file declares its own",
  'modules/webhooks/webhook.transport.ts':
    "the package builds the transport in its own module, where WebhooksRepository isn't provided",
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

describe('the layers', () => {
  const src = import.meta.dirname;
  const files = sources(src)
    .filter((file) => !isTest(file))
    .map((file) => ({ file, path: relative(src, file) }));

  it('keeps queries out of controllers', () => {
    const found = files
      .filter(
        ({ path }) =>
          path.endsWith('.controller.ts') &&
          !CONTROLLERS_NOT_YET.includes(path),
      )
      .flatMap(({ file, path }) =>
        specifiersOf(file)
          .filter((from) => isDrizzle(from) || from.endsWith('.tables.js'))
          .map((from) => `${path} -> ${from}`),
      );
    expect(found).toEqual([]);
  });

  it('keeps queries in repositories in the converted folders', () => {
    const found = files
      .filter(
        ({ file, path }) =>
          CONVERTED.includes(moduleOf(src, file) ?? '') &&
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

  it('lists only controllers that still import queries', () => {
    const stale = CONTROLLERS_NOT_YET.filter(
      (path) =>
        !specifiersOf(`${src}/${path}`).some(
          (from) => isDrizzle(from) || from.endsWith('.tables.js'),
        ),
    );
    expect(stale).toEqual([]);
  });
});
