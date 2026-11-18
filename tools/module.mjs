#!/usr/bin/env node
// `pnpm module:list` and `pnpm module:remove <name> [--apply]`: what an
// adopter may drop, and dropping it (docs/removing-a-module.md). A module is
// its folder and its line in app.module.ts (AGENTS.md, rules 2 and 3), so
// removing one is deleting both, its web pages, then running the commands
// that regenerate what was derived from it: the migration, env.example, the
// typed client and the route tree. Without --apply it only says what it
// would do. It refuses while anything else uses the module: who depends on
// whom comes from the same graph the dependency rule is checked on
// (apps/api/test/module-graph.ts).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { inside, REPO } from './cli-paths.mjs';
import { regenerateRouteTree } from './route-tree.mjs';

const API = 'apps/api';
const SRC = `${API}/src`;
const WEB = 'apps/web/src';

const graphUrl = (root) =>
  pathToFileURL(path.join(root, API, 'test/module-graph.ts')).href;

/** The shared graph (apps/api/test/module-graph.ts), loaded with Node's type stripping. */
async function loadGraph(root) {
  return import(graphUrl(root));
}

/** The feature generator's add-ons (apps/api/schematics/feature/addons.js), by the paths they import. */
async function loadAddons(root) {
  const file = path.join(root, API, 'schematics/feature/addons.js');
  return existsSync(file) ? import(pathToFileURL(file).href) : { ADDONS: {} };
}

/**
 * The fixture the generator's drift test compares with its output
 * (apps/api/test/fixtures/generated-feature.spec.ts), and the options it is
 * generated with: written again, with the add-ons left, after a removal.
 */
const GENERATED = `${API}/test/fixtures/generated-feature`;
const GENERATED_OPTIONS = `${API}/test/fixtures/generated-feature.options.json`;

/** A module's own test fixtures: `apps/api/test/fixtures/<name>`, removed with it. */
const fixtureOf = (target) => `${API}/test/fixtures/${target.name}`;

/** The TypeScript compiler, the API's dependency: app.module.ts is read as code, not text. */
async function loadTypeScript(root) {
  const api = createRequire(path.join(root, API, 'package.json'));
  return (await import(pathToFileURL(api.resolve('typescript')).href)).default;
}

const rel = (root, file) => path.relative(root, file).split(path.sep).join('/');

function files(root, pattern, cwd = '.') {
  return globSync(pattern, {
    cwd: path.join(root, cwd),
    exclude: (name) => name === 'node_modules' || name === 'dist',
  }).map((file) => path.join(cwd, file).split(path.sep).join('/'));
}

const read = (root, file) => readFileSync(path.join(root, file), 'utf8');

/**
 * `favorites`, `modules/favorites` or `features/invoices` to the module's
 * id and folder. A bare name must be one level's only; `core` is always
 * there (apps/api/AGENTS.md) and is never removed.
 */
export function resolveName(root, name, LEVELS) {
  const given = String(name ?? '')
    .replace(/^(\.\/)?(apps\/api\/)?src\//, '')
    .replace(/\/$/, '');
  const parts = given.split('/');
  if (
    parts.length > 2 ||
    !parts.every((part) => /^[a-z0-9][a-z0-9-]*$/.test(part))
  ) {
    throw new Error(
      `"${name}": a module is named by its folder: favorites, modules/favorites, features/invoices.`,
    );
  }
  const exists = (level, folder) => {
    const dir = path.join(root, SRC, level, folder);
    return existsSync(dir) && statSync(dir).isDirectory();
  };
  let found;
  if (parts.length === 2) {
    if (!LEVELS.includes(parts[0])) {
      throw new Error(`"${name}": the levels are ${LEVELS.join(', ')}.`);
    }
    found = exists(parts[0], parts[1]) ? [given] : [];
  } else {
    found = LEVELS.filter((level) => exists(level, given)).map(
      (level) => `${level}/${given}`,
    );
  }
  if (found.length === 0) throw new Error(`No module "${name}" in ${SRC}.`);
  if (found.length > 1) {
    throw new Error(
      `"${name}" is ambiguous: ${found.join(', ')}. Name it with its level.`,
    );
  }
  const [id] = found;
  if (id.startsWith('core/')) {
    throw new Error(
      `${id} is core: always there, never removed (apps/api/AGENTS.md, "Folders").`,
    );
  }
  return { id, name: id.split('/')[1], dir: `${SRC}/${id}` };
}

/** The modules an adopter may consider: every one above core. */
export function modulesIn(root, LEVELS) {
  return LEVELS.filter((level) => level !== 'core').flatMap((level) => {
    const dir = path.join(root, SRC, level);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => statSync(path.join(dir, name)).isDirectory())
      .sort()
      .map((name) => `${level}/${name}`);
  });
}

const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

/**
 * Everything outside the module's folder that uses it, in the API: modules
 * (the dependency graph, tests left out, as the rule reads it), the
 * entry points and commands (src/cli, src/demo, main.ts…), tests, and the
 * feature generator, which names its add-ons by path.
 */
export function apiDependents(root, target, graph, addons) {
  const src = path.join(root, SRC);
  const found = [];
  for (const [from, targets] of graph.moduleGraph(src)) {
    if (targets.has(target.id)) found.push({ kind: 'module', by: from });
  }
  const owned = [path.join(src, target.id), path.join(root, fixtureOf(target))];
  const scanned = [
    ...graph.sources(src),
    ...graph.sources(path.join(root, API, 'test')),
  ];
  for (const file of scanned) {
    const name = rel(root, file);
    if (
      under(name, target.dir) ||
      under(name, fixtureOf(target)) ||
      // Generator output, written again after the removal (regenerated()).
      under(name, GENERATED) ||
      name === `${SRC}/app.module.ts`
    ) {
      continue;
    }
    const module = graph.moduleOf(src, file);
    const isTest = graph.isTest(file) || under(name, `${API}/test`);
    // A module's own code is in the graph above.
    if (module && !isTest) continue;
    if (
      graph.importsOf(file).some((to) => owned.some((dir) => under(to, dir)))
    ) {
      found.push({ kind: isTest ? 'test' : 'app', by: name });
    }
  }
  // The generator's templates name what a feature imports by path
  // ('modules/records/…'); so may another add-on's file, and its imports
  // and what its e2e spec boots are paths too.
  const named = new RegExp(`['"]${target.id}/`);
  const others = files(root, 'modules/*/*.addon.js', SRC).filter(
    (file) => !under(file, target.dir),
  );
  for (const file of [
    ...files(root, '**/*.js', `${API}/schematics`),
    ...others,
  ]) {
    if (named.test(read(root, file))) {
      found.push({ kind: 'generator', by: file });
    }
  }
  for (const [addon, spec] of Object.entries(addons.ADDONS)) {
    const file = `${SRC}/modules/${addon}/${addon}.addon.js`;
    if (
      `modules/${addon}` === target.id ||
      !existsSync(path.join(root, file))
    ) {
      continue;
    }
    const paths = [spec.imports, spec.boot, spec.columns].flatMap((map) =>
      Object.values(map ?? {}),
    );
    if (paths.some((to) => typeof to === 'string' && under(to, target.id))) {
      found.push({
        kind: 'generator',
        by: file,
        why: `the add-on "${addon}"`,
      });
    }
  }
  // One line per place: a file may name it twice.
  return [...new Map(found.map((d) => [`${d.kind} ${d.by}`, d])).values()];
}

/** The operations of the module's controllers, from the client's OpenAPI document (operationId is `Class_method_v1`). */
export function routesOf(root, target) {
  const doc = path.join(root, 'packages/api-client/openapi.json');
  if (!existsSync(doc)) return [];
  const classes = new Set(
    files(root, '**/*.ts', target.dir)
      .filter((file) => !/\.(spec|e2e-spec)\.ts$/.test(file))
      .flatMap((file) =>
        [...read(root, file).matchAll(/\bclass\s+(\w+)/g)].map(([, n]) => n),
      ),
  );
  const routes = [];
  for (const [route, operations] of Object.entries(
    JSON.parse(readFileSync(doc, 'utf8')).paths,
  )) {
    for (const [method, operation] of Object.entries(operations)) {
      const owner = operation?.operationId?.split('_')[0];
      if (owner && classes.has(owner)) {
        routes.push({ method: method.toUpperCase(), path: route });
      }
    }
  }
  return routes;
}

/** `/v1/tags/{id}`, `/v1/tags/:id` and `/v1/tags/${id}` read as one path. */
const normalPath = (route) =>
  route
    .replace(/\$\{[^}]*\}/g, '{}')
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/:[A-Za-z_]\w*/g, '{}')
    .replace(/\/$/, '');

/** The API paths a web file names: the typed client's, msw's and fetch's. */
const pathsIn = (text) =>
  [...text.matchAll(/['"`](\/v\d+\/[^'"`\s?]*)/g)].map(([, p]) =>
    normalPath(p),
  );

/**
 * The blocks of `text` marked for the module, a line each way:
 * `// capability:<name> begin` … `// capability:<name> end` (or the
 * `{/* … *\/}` of JSX). Code a module adds to a shared web file is marked so;
 * removing the module removes the blocks. `text` without them, how many,
 * and a problem when the markers don't pair.
 */
export function unmark(text, name) {
  const marker = new RegExp(
    `^\\s*(?://|\\{/\\*)\\s*capability:${name} (begin|end)\\b`,
  );
  const kept = [];
  let open = false;
  let blocks = 0;
  let problem;
  for (const line of text.split('\n')) {
    const found = line.match(marker);
    if (found?.[1] === 'begin') {
      if (open) problem ??= 'a begin inside a block';
      open = true;
      blocks += 1;
    } else if (found?.[1] === 'end') {
      if (!open) problem ??= 'an end without its begin';
      open = false;
    } else if (!open) {
      kept.push(line);
    }
  }
  if (open) problem ??= 'a begin without its end';
  return { text: kept.join('\n'), blocks, problem };
}

/**
 * The module's part of the web app, by its conventions: a feature folder
 * `apps/web/src/features/<f>` named after the module or its route
 * (`naming-series` for `/v1/naming-series`), with its nav entry, tests and
 * texts (`locales/<lng>/<f>.json`); the pages under `routes/` built from
 * those folders alone; the browser test `apps/web-e2e/test/<f>.spec.ts`;
 * and the blocks marked `capability:<name>` in shared files. Whatever else
 * uses those files, the module's routes or its texts is a blocker: it has
 * to change first.
 */
export function webPart(root, target, routes, LEVELS) {
  const web = path.join(root, WEB);
  const none = { remove: [], marked: [], blockers: [] };
  if (!existsSync(web)) return none;
  const paths = new Set(routes.map((r) => normalPath(r.path)));
  // A route's first segment names the module's web feature unless it is
  // another module's name (messaging's `/v1/webhooks/…` is not the
  // webhooks feature).
  const modules = modulesIn(root, LEVELS).map((id) => id.split('/')[1]);
  const names = new Set([
    target.name,
    ...routes
      .map((r) => r.path.split('/')[2])
      .filter((segment) => segment && !modules.includes(segment)),
  ]);
  const folders = [...names].filter((n) =>
    existsSync(path.join(web, 'features', n)),
  );
  const all = files(root, '**/*.{ts,tsx,mts,js}', 'apps/web').filter(
    (file) =>
      !file.endsWith('routeTree.gen.ts') && !under(file, 'apps/web/public'),
  );
  const featureImports = (text) =>
    [...text.matchAll(/['"]@\/features\/([^/'"]+)/g)].map(([, f]) => f);
  const remove = new Set(
    all.filter((file) =>
      folders.some((f) => under(file, `${WEB}/features/${f}`)),
    ),
  );
  // A route file is the module's when it imports the module's feature and,
  // from any other, only the permission gate every page's route takes
  // (`requirePermission`, features/access/gate).
  for (const file of all.filter((f) => under(f, `${WEB}/routes`))) {
    const text = unmark(read(root, file), target.name).text;
    const imports = [
      ...text.matchAll(
        /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@\/features\/([^/'"]+)/g,
      ),
    ].map(([, names, feature]) => ({
      feature,
      names: names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean),
    }));
    if (
      featureImports(text).some((f) => folders.includes(f)) &&
      imports.every(
        (i) =>
          folders.includes(i.feature) ||
          i.names.every((n) => n === 'requirePermission'),
      )
    ) {
      remove.add(file);
    }
  }
  const locales = folders.flatMap((f) =>
    files(root, `*/${f}.json`, `${WEB}/locales`),
  );
  // The browser tests (Playwright, apps/web-e2e/test): `<f>.spec.ts` is
  // the web feature's own.
  const browser = files(root, '**/*.ts', 'apps/web-e2e').filter(
    (file) => !/playwright-report|test-results/.test(file),
  );
  const ownTests = browser.filter(
    (file) =>
      under(file, 'apps/web-e2e/test') &&
      folders.includes(path.basename(file, '.spec.ts')),
  );
  const marked = [];
  const blockers = [];
  for (const file of [...all, ...browser]) {
    if (remove.has(file) || ownTests.includes(file)) continue;
    const { text, blocks, problem } = unmark(read(root, file), target.name);
    if (problem) {
      blockers.push({
        kind: 'web',
        by: file,
        why: `capability:${target.name} markers: ${problem}`,
      });
      continue;
    }
    if (blocks) marked.push({ file, blocks, text });
    const why = [];
    const imported = featureImports(text).filter((f) => folders.includes(f));
    if (imported.length) why.push(`imports features/${imported[0]}`);
    const named = pathsIn(text).find((p) => paths.has(p));
    if (named) why.push(`calls ${named}`);
    const relative = [...text.matchAll(/from '(\.\.?\/[^']+)'/g)]
      .map(([, spec]) =>
        rel(root, path.resolve(root, path.dirname(file), spec)),
      )
      .find((to) =>
        [...remove].some(
          (r) => r === to || r.startsWith(`${to}.`) || r.startsWith(`${to}/`),
        ),
      );
    if (relative) why.push(`imports ${relative}`);
    const texts = folders.find((f) =>
      new RegExp(`['"\`]${f}:|useTranslation\\(\\s*\\[?['"]${f}['"]`).test(
        text,
      ),
    );
    if (texts) why.push(`uses the ${texts} texts`);
    if (why.length) {
      blockers.push({
        kind: under(file, 'apps/web-e2e') ? 'web-e2e' : 'web',
        by: file,
        why: why.join(', '),
      });
    }
  }
  return {
    remove: [...remove, ...locales, ...ownTests].sort(),
    marked,
    blockers,
  };
}

/** The tables and enums its `*.tables.ts` declare: the drop migration's contents. */
export function tablesOf(root, target) {
  return files(root, '**/*.tables.ts', target.dir).map((file) => ({
    file,
    names: [
      ...read(root, file).matchAll(
        /export const \w+\s*=\s*(\w+)\(\s*['"]([\w-]+)['"]/g,
      ),
    ]
      .filter(([, fn]) => /Table$|Enum$|Schema$|View$/.test(fn))
      .map(([, , name]) => name),
  }));
}

/**
 * Its environment variables, as env.example lists them (generated from the
 * `schema` of every *.config.ts, tools/env-example.mjs): under the module's
 * own headings. One another config also declares stays.
 */
export function envOf(root, target) {
  const example = path.join(root, API, 'env.example');
  if (!existsSync(example)) return [];
  const variables = [];
  let mine = false;
  for (const line of readFileSync(example, 'utf8').split('\n')) {
    const heading = line.match(/^# --- (.+) ---$/);
    if (heading) mine = under(heading[1], target.id);
    const variable = line.match(/^#? ?([A-Z][A-Z0-9_]*)=/);
    if (mine && variable) variables.push(variable[1]);
  }
  const others = files(root, '**/*.config.ts', SRC).filter(
    (file) => !under(file, target.dir),
  );
  return variables.map((name) => ({
    name,
    alsoIn: others.filter((file) =>
      new RegExp(`\\b${name}\\s*:`).test(read(root, file)),
    ),
  }));
}

/**
 * The module's imports and entries in app.module.ts, as the compiler reads
 * them, and the file without them. Anything else naming them there is a
 * problem: the tool edits only the import lines and the `imports: [...]`
 * entries (with the comment above one, when it heads that entry alone).
 */
export function appModuleEdit(ts, text, target) {
  const file = ts.createSourceFile(
    'app.module.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const prefix = `./${target.id}/`;
  const declarations = file.statements.filter(
    (s) =>
      ts.isImportDeclaration(s) && s.moduleSpecifier.text.startsWith(prefix),
  );
  const names = new Set(
    declarations.flatMap((d) => {
      const bindings = d.importClause?.namedBindings;
      return [
        ...(d.importClause?.name ? [d.importClause.name.text] : []),
        ...(bindings && ts.isNamedImports(bindings)
          ? bindings.elements.map((e) => e.name.text)
          : []),
      ];
    }),
  );
  const elements = [];
  const problems = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text)) {
      // The entry itself: `XModule` or `XModule.forRoot(...)`.
      let entry = node;
      while (
        entry.parent &&
        (ts.isPropertyAccessExpression(entry.parent) ||
          ts.isCallExpression(entry.parent)) &&
        !ts.isArrayLiteralExpression(entry.parent)
      ) {
        entry = entry.parent;
      }
      const list = entry.parent;
      const property = list?.parent;
      if (
        list &&
        ts.isArrayLiteralExpression(list) &&
        property &&
        ts.isPropertyAssignment(property) &&
        property.name.getText(file) === 'imports'
      ) {
        if (!elements.includes(entry)) elements.push(entry);
      } else {
        const { line } = file.getLineAndCharacterOfPosition(
          node.getStart(file),
        );
        problems.push(
          `line ${line + 1}: ${node.text} used outside the imports list`,
        );
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);

  const lineStart = (pos) => text.lastIndexOf('\n', pos - 1) + 1;
  const lineEnd = (pos) => {
    const end = text.indexOf('\n', pos);
    return end < 0 ? text.length : end + 1;
  };
  const ranges = declarations.map((d) => [
    lineStart(d.getStart(file)),
    lineEnd(d.getEnd()),
  ]);
  const comments = [];
  const removedComments = [];
  for (const element of elements) {
    const start = element.getStart(file);
    let end = element.getEnd();
    if (text[end] === ',') end += 1;
    if (
      text.slice(lineStart(start), start).trim() !== '' ||
      text.slice(end, lineEnd(end)).trim() !== ''
    ) {
      problems.push(
        `${element.getText(file)} shares its line with another entry`,
      );
      continue;
    }
    // A comment above the entry heads the entries after it up to the next
    // comment: when it heads this one alone it goes with it; when others
    // follow, whether it was about this one only a reader can tell.
    const leading = (node) =>
      ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
    const own = leading(element);
    const siblings = element.parent.elements;
    const after = siblings[siblings.indexOf(element) + 1];
    const alone =
      !after || leading(after).length > 0 || elements.includes(after);
    if (own.length && alone) {
      ranges.push([lineStart(own[0].pos), lineEnd(end)]);
      removedComments.push(...own.map((r) => text.slice(r.pos, r.end)));
    } else {
      ranges.push([lineStart(start), lineEnd(end)]);
      comments.push(...own.map((r) => text.slice(r.pos, r.end)));
    }
  }
  let next = text;
  for (const [from, to] of ranges.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, from) + next.slice(to);
  }
  return {
    imports: declarations.map((d) => d.getText(file)),
    entries: elements.map((e) => e.getText(file)),
    comments,
    removedComments,
    problems,
    text: next,
  };
}

/** Markdown links into the module's folder, and the PORTING.md lines naming it. */
export function docsOf(root, target) {
  const links = [];
  const mdFiles = files(root, '**/*.md').filter(
    (file) => !under(file, target.dir) && !file.includes('node_modules'),
  );
  for (const file of mdFiles) {
    read(root, file)
      .split('\n')
      .forEach((line, at) => {
        const into = [...line.matchAll(/\]\(([^)\s#]+)/g)].some(([, href]) => {
          if (/^[a-z]+:/i.test(href)) return false;
          const to = rel(root, path.resolve(root, path.dirname(file), href));
          return under(to, target.dir);
        });
        if (!into) return;
        // A line that is only a link to it (a list's entry) goes with it;
        // a sentence that links to it is the adopter's to rewrite.
        const alone = /^\s*[-*]\s*\[[^\]]*\]\([^)]*\)[.;,]?\s*$/.test(line);
        links.push({ file, line: at + 1, text: line.trim(), alone });
      });
  }
  const porting = existsSync(path.join(root, 'PORTING.md'))
    ? read(root, 'PORTING.md')
        .split('\n')
        .map((text, at) => ({ line: at + 1, text: text.trim() }))
        .filter(({ text }) =>
          new RegExp(`(^|[^\\w-])${target.name}([^\\w-]|$)`).test(text),
        )
    : [];
  return { links, porting };
}

/** Its files' entries in the raw SQL allowlist (tools/ci/raw-sql.mjs fails on one whose file is gone). */
export function rawSqlEntries(root, target) {
  const file = path.join(root, 'tools/ci/raw-sql.allow.json');
  if (!existsSync(file)) return [];
  return Object.keys(JSON.parse(readFileSync(file, 'utf8'))).filter((f) =>
    under(f, target.dir),
  );
}

/**
 * What its README says about removing it (apps/api/AGENTS.md: a README says
 * "how to remove it"): the paragraph starting `Remove…:`, or the one under a
 * `## Remov…` heading. It may name a step no command does.
 */
export function removalNote(root, target) {
  const file = path.join(root, target.dir, 'README.md');
  if (!existsSync(file)) return undefined;
  const paragraphs = readFileSync(file, 'utf8').split(/\n\s*\n/);
  const at = paragraphs.findIndex((p) =>
    /^#+ Remov|(^|\. |\*\*)Remove[^:\n]*:/m.test(p),
  );
  if (at < 0) return undefined;
  const found = /^#+ /.test(paragraphs[at])
    ? paragraphs[at + 1]
    : paragraphs[at].slice(paragraphs[at].search(/(\*\*)?Remove[^:\n]*:/));
  return found?.replace(/\s+/g, ' ').trim();
}

/** Everything `remove` needs to say or do, computed without touching a file. */
export async function plan(root, name) {
  root = path.resolve(root);
  const graph = await loadGraph(root);
  const ts = await loadTypeScript(root);
  const target = resolveName(root, name, graph.LEVELS);
  const routes = routesOf(root, target);
  const web = webPart(root, target, routes, graph.LEVELS);
  return {
    target,
    files: files(root, '**/*', target.dir).filter((f) =>
      statSync(path.join(root, f)).isFile(),
    ),
    dependents: [
      ...apiDependents(root, target, graph, await loadAddons(root)),
      ...web.blockers,
    ],
    appModule: appModuleEdit(ts, read(root, `${SRC}/app.module.ts`), target),
    tables: tablesOf(root, target),
    env: envOf(root, target),
    routes,
    web: web.remove,
    marked: web.marked,
    docs: docsOf(root, target),
    rawSql: rawSqlEntries(root, target),
    note: removalNote(root, target),
    fixtures: existsSync(path.join(root, fixtureOf(target)))
      ? fixtureOf(target)
      : undefined,
    // An add-on's part is in the fixture generated with every add-on.
    generated:
      target.id === `modules/${target.name}` &&
      existsSync(path.join(root, target.dir, `${target.name}.addon.js`)) &&
      existsSync(path.join(root, GENERATED_OPTIONS)),
  };
}

const KINDS = {
  module: 'module',
  app: 'app code',
  test: 'test',
  generator: 'feature generator',
  web: 'web app',
  'web-e2e': 'browser test',
};

/** The dry run's text (and the first half of --apply's). */
export function describe(p) {
  const out = [];
  const list = (title, items) => {
    out.push(`\n${title}${items.length ? '' : ' none'}`);
    for (const item of items) out.push(`  ${item}`);
  };
  out.push(`Removing ${p.target.id} (${p.target.dir})`);
  if (p.dependents.length) {
    out.push(
      `\nREFUSED: ${p.dependents.length} place(s) use ${p.target.id}:`,
      ...p.dependents.map(
        (d) => `  ${KINDS[d.kind]}: ${d.by}${d.why ? ` (${d.why})` : ''}`,
      ),
      `\nRemove those first (pnpm module:remove <it>), or change them so they no longer use ${p.target.id}, then run this again.`,
    );
    return out.join('\n');
  }
  if (p.appModule.problems.length) {
    out.push(
      '\nREFUSED: app.module.ts names it where this tool does not edit:',
      ...p.appModule.problems.map((x) => `  ${x}`),
    );
    return out.join('\n');
  }
  if (p.note) out.push(`\nIts README: ${p.note}`);
  list(`Folder (${p.files.length} files):`, [p.target.dir]);
  list('Its test fixtures:', p.fixtures ? [p.fixtures] : []);
  if (p.generated) {
    list('Its add-on, gone from the fixture generated with every add-on:', [
      GENERATED,
    ]);
  }
  list('app.module.ts, lines removed:', [
    ...p.appModule.imports,
    ...p.appModule.removedComments,
    ...p.appModule.entries.map((e) => `${e},  (imports: [...])`),
  ]);
  if (p.appModule.comments.length) {
    list(
      'app.module.ts, comments above its entry that stay (delete one that was about it):',
      p.appModule.comments,
    );
  }
  list(
    'Tables dropped (the migration `drizzle-kit generate` writes, with their DATA):',
    p.tables.flatMap((t) => t.names.map((n) => `${n}  (${t.file})`)),
  );
  list(
    'Environment variables gone from env.example:',
    p.env.map((v) =>
      v.alsoIn.length
        ? `${v.name}  (stays: also ${v.alsoIn.join(', ')})`
        : v.name,
    ),
  );
  list(
    'Routes gone from the API and the typed client:',
    p.routes.map((r) => `${r.method} ${r.path}`),
  );
  list('Web app files removed (pages, nav entry, texts, tests):', p.web);
  list(
    `Web app blocks marked capability:${p.target.name}, removed:`,
    p.marked.map((m) => `${m.file} (${m.blocks})`),
  );
  list('Raw SQL allowlist entries removed:', p.rawSql);
  list(
    'Docs linking to it:',
    p.docs.links.map(
      (l) =>
        `${l.file}:${l.line} ${l.alone ? '(removed: a line that is only the link)' : '(rewrite it)'}  ${l.text}`,
    ),
  );
  list(
    'PORTING.md lines naming it (review):',
    p.docs.porting.map((l) => `PORTING.md:${l.line} ${l.text}`),
  );
  return out.join('\n');
}

const refused = (p) =>
  p.dependents.length > 0 || p.appModule.problems.length > 0;

function pruneEmptyDirs(dir, stop) {
  while (under(dir, stop) && dir !== stop && existsSync(dir)) {
    if (readdirSync(dir).length > 0) return;
    rmdirSync(dir);
    dir = path.dirname(dir);
  }
}

/** The file edits and deletions; the generators run after. */
export function applyEdits(root, p) {
  writeFileSync(path.join(root, SRC, 'app.module.ts'), p.appModule.text);
  rmSync(inside(root, p.target.dir), { recursive: true });
  if (p.fixtures) rmSync(inside(root, p.fixtures), { recursive: true });
  for (const file of p.web) {
    rmSync(inside(root, file));
    pruneEmptyDirs(path.join(root, path.dirname(file)), path.join(root, WEB));
  }
  for (const { file, text } of p.marked) {
    writeFileSync(inside(root, file), text);
  }
  const byFile = Map.groupBy(
    p.docs.links.filter((l) => l.alone),
    (l) => l.file,
  );
  for (const [file, links] of byFile) {
    const drop = new Set(links.map((l) => l.line));
    const lines = read(root, file).split('\n');
    writeFileSync(
      inside(root, file),
      lines.filter((_, at) => !drop.has(at + 1)).join('\n'),
    );
  }
  if (p.rawSql.length) {
    const file = path.join(root, 'tools/ci/raw-sql.allow.json');
    const allowed = JSON.parse(readFileSync(file, 'utf8'));
    for (const key of p.rawSql) delete allowed[key];
    writeFileSync(file, `${JSON.stringify(allowed, null, 2)}\n`);
  }
}

function run(root, command, args) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  // stdin closed: a generator that would ask a question fails instead of
  // waiting for an answer no one gives.
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status ?? result.signal}). The files are already removed: fix the cause and run it, and the steps after it, by hand.`,
    );
  }
}

/**
 * The generated-feature fixture written again by the generator with the
 * options its drift test reads, now without the removed add-on.
 */
function regenerateFixture(root) {
  const options = JSON.parse(read(root, GENERATED_OPTIONS));
  rmSync(inside(root, GENERATED), { recursive: true, force: true });
  run(root, 'pnpm', [
    '--filter',
    'api',
    'feature:add',
    // The CLI takes them kebab-cased (skipImport is --skip-import).
    ...Object.entries(options).map(([key, value]) => {
      const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      return value === true ? `--${flag}` : `--${flag}=${value}`;
    }),
  ]);
}

function newMigrations(root, before) {
  return files(root, '*/migration.sql', `${API}/drizzle`).filter(
    (file) => !before.includes(file),
  );
}

async function remove(root, name, apply) {
  const p = await plan(root, name);
  console.log(describe(p));
  if (refused(p)) return 1;
  const steps = [
    ...(p.generated
      ? [
          `${GENERATED}, with the add-ons left (pnpm --filter api feature:add, ${GENERATED_OPTIONS})`,
        ]
      : []),
    ...(p.generated || p.fixtures
      ? [
          `pnpm --filter api db:generate:fixtures --name remove-${p.target.name}`,
        ]
      : []),
    ...(p.tables.some((t) => t.names.length)
      ? [`pnpm --filter api db:generate --name remove-${p.target.name}`]
      : []),
    'pnpm env:example',
    'pnpm client:generate',
    ...(p.web.length || p.marked.length
      ? ['the web route tree (apps/web/src/routeTree.gen.ts)']
      : []),
  ];
  console.log('\nThen regenerates:', ...steps.map((s) => `\n  ${s}`));
  if (!apply) {
    console.log('\nDry run: nothing changed. Run again with --apply to do it.');
    return 0;
  }
  applyEdits(root, p);
  console.log(`\nRemoved ${p.target.dir} and its lines.`);
  const before = files(root, '*/migration.sql', `${API}/drizzle`);
  if (p.tables.some((t) => t.names.length)) {
    run(root, 'pnpm', [
      '--filter',
      'api',
      'db:generate',
      '--name',
      `remove-${p.target.name}`,
    ]);
  }
  if (p.generated) regenerateFixture(root);
  // The fixtures' tables: what the regenerated fixture and the removed
  // module's own fixtures no longer have (drizzle-kit writes nothing when
  // nothing changed).
  if (p.generated || p.fixtures) {
    run(root, 'pnpm', [
      '--filter',
      'api',
      'db:generate:fixtures',
      '--name',
      `remove-${p.target.name}`,
    ]);
  }
  run(root, 'pnpm', ['env:example']);
  run(root, 'pnpm', ['client:generate']);
  if (p.web.length || p.marked.length) await regenerateRouteTree(root);
  const migrations = newMigrations(root, before);
  const bar = '!'.repeat(72);
  console.log(`\nDone. Still to check:`);
  if (migrations.length) {
    console.log(
      `\n${bar}\n  ${migrations.join(', ')} DROPS ${p.tables.flatMap((t) => t.names).join(', ')}.\n  Applied on the next deploy, it deletes those tables WITH THEIR DATA.\n  Export what must be kept first. Read the SQL before committing.\n${bar}`,
    );
  }
  for (const line of [
    p.appModule.comments.length &&
      'app.module.ts: the comment(s) above its entry stayed; delete one that was about it.',
    p.docs.links.some((l) => !l.alone) &&
      'docs: the sentences linking to it (listed above) still do.',
    p.docs.porting.length && 'PORTING.md: the lines naming it (listed above).',
    p.note &&
      `its README's note (above): a step it names that this tool did not take is yours.`,
    'pnpm build && pnpm lint && pnpm test && pnpm test:e2e, then commit the removal with what was regenerated.',
  ].filter(Boolean)) {
    console.log(`  - ${line}`);
  }
  return 0;
}

/** Every module above core: its level, and who uses it (none: removable). */
export async function list(root) {
  root = path.resolve(root);
  const graph = await loadGraph(root);
  const addons = await loadAddons(root);
  const rows = [];
  for (const id of modulesIn(root, graph.LEVELS)) {
    const target = resolveName(root, id, graph.LEVELS);
    const routes = routesOf(root, target);
    const dependents = [
      ...apiDependents(root, target, graph, addons),
      ...webPart(root, target, routes, graph.LEVELS).blockers,
    ];
    rows.push({ id, dependents });
  }
  return rows;
}

function printList(rows) {
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const { id, dependents } of rows) {
    const modules = dependents
      .filter((d) => d.kind === 'module')
      .map((d) => d.by);
    const others = dependents.length - modules.length;
    const used = [...modules, ...(others ? [`${others} other place(s)`] : [])];
    console.log(
      `${id.padEnd(width)}  ${used.length ? `used by ${used.join(', ')}` : 'removable'}`,
    );
  }
  console.log(
    '\npnpm module:remove <name> says what removing one does (a dry run), and every place that uses it.',
  );
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { apply: { type: 'boolean', default: false } },
  });
  const [command, name, ...rest] = positionals;
  if (command === 'list' && !name) {
    printList(await list(REPO));
    return 0;
  }
  if (command === 'remove' && name && rest.length === 0) {
    return remove(REPO, name, values.apply);
  }
  console.error(
    'Usage: pnpm module:list | pnpm module:remove <name> [--apply]',
  );
  return 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
