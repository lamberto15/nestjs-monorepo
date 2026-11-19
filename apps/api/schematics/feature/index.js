// The `feature` schematic: a feature's files in its folder (`path`, default
// src/features/<name>), and its module in src/app.module.ts's imports, the
// one central line a feature needs (`--skip-import` leaves it out). With
// `--web-root` (the web app's src, from the same root: the repository's,
// `pnpm feature:add`) also its web pages (web-feature/templates.js). Plain
// ESM: Nest's CLI runs it as it is, no build step. Run it with
// `nest g -c ./schematics/collection.json feature <name>` from apps/api, which
// asks for what is not given (schema.json's prompts); docs/adding-a-feature.md.

import { posix } from 'node:path';
import { ModuleDeclarator } from '@nestjs/schematics';
import { format, resolveConfig } from 'prettier';
import { ADDONS, parseAddons } from './addons.js';
import { parseFields } from './fields.js';
import { kebabOf, names } from './names.js';
import * as templates from './templates.js';
import * as web from '../web-feature/templates.js';

const clean = (path) =>
  posix.normalize(String(path)).replace(/^\.\//, '').replace(/\/$/, '');

/** The generation's context, every option checked before anything is written. */
export function context(options) {
  const t = names(options.name, options.singular);
  const fields = parseFields(options.fields);
  const addons = parseAddons(options.addons);
  const sourceRoot = clean(options.sourceRoot || 'src');
  const base = clean(options.path || posix.join(sourceRoot, 'features'));
  const dir = options.flat ? base : posix.join(base, t.plural);
  if (dir.startsWith('..') || posix.isAbsolute(dir)) {
    throw new Error(
      '--path "' + options.path + '": a folder inside the project.',
    );
  }
  if (!['standard', 'none', undefined].includes(options.grants)) {
    throw new Error('--grants: standard or none.');
  }
  if (
    !['required', 'optional', 'off', undefined, ''].includes(
      options.idempotency,
    )
  ) {
    throw new Error('--idempotency: required, optional or off.');
  }
  const webRoot = options.webRoot ? clean(options.webRoot) : null;
  if (webRoot && (webRoot.startsWith('..') || posix.isAbsolute(webRoot))) {
    throw new Error(
      '--web-root "' + options.webRoot + '": a folder inside the project.',
    );
  }
  const c = {
    t,
    fields,
    addons,
    dir,
    sourceRoot,
    webRoot,
    softDelete: options.softDelete !== false,
    unit: options.unit === true,
    clientAccess: options.clientAccess === true,
    grants: options.grants ?? 'standard',
    idempotency: options.idempotency || undefined,
    approvals: [],
    R: t.SINGULAR,
    T: t.pluralCamel,
    src: posix.relative(dir, sourceRoot),
    // The app's test/ beside its src/ (src → test; apps/api/src → apps/api/test).
    test: posix.relative(dir, posix.join(posix.dirname(sourceRoot), 'test')),
    url: '/v1/' + t.plural,
    writer:
      options.grants === 'none' ? 'team.admin.headers' : 'team.editor.headers',
    enumField: fields.find((f) => f.type === 'enum') ?? null,
    kebab: kebabOf,
  };
  for (const name of addons) {
    Object.assign(c, ADDONS[name].prepare?.(c, options, ADDONS));
    ADDONS[name].check?.(c);
  }
  return c;
}

/** Every file of the feature, by its path from the project's root, unformatted. */
export function files(c) {
  const { t } = c;
  const at = (name) => posix.join(c.dir, name);
  return {
    [at(t.singular + '.record.ts')]: templates.record(c),
    [at(t.plural + '.tables.ts')]: templates.tables(c),
    [at(t.singular + '.schemas.ts')]: templates.schemas(c),
    [at(t.singular + '.list.ts')]: templates.list(c),
    [at(t.singular + '.permissions.ts')]: templates.permissions(c),
    [at(t.singular + '.policy.ts')]: templates.policy(c),
    [at(t.plural + '.service.ts')]: templates.service(c),
    [at(t.plural + '.controller.ts')]: templates.controller(c),
    [at(t.plural + '.module.ts')]: templates.moduleFile(c),
    // The files of the add-ons' own (an approval's effects, a PDF's page…).
    ...Object.fromEntries(
      c.addons.flatMap((name) =>
        Object.entries(ADDONS[name].files?.(c) ?? {}).map(([file, text]) => [
          at(file),
          text,
        ]),
      ),
    ),
    [at('i18n/en.json')]: templates.texts(c),
    [at(t.plural + '.e2e-spec.ts')]: templates.e2e(c),
    [at('README.md')]: templates.readme(c),
    ...(c.webRoot && webFiles(c)),
  };
}

/** The feature's web pages, texts and test, under the web app's src (`webRoot`). */
function webFiles(c) {
  const paths = web.webPaths(c.t);
  const at = (name) => posix.join(c.webRoot, name);
  return {
    [at(paths.api)]: web.api(c),
    [at(paths.form)]: web.form(c),
    [at(paths.remove)]: web.remove(c),
    [at(paths.nav)]: web.nav(c),
    [at(paths.test)]: web.test(c),
    [at(paths.list)]: web.listPage(c),
    [at(paths.new)]: web.newPage(c),
    [at(paths.detail)]: web.detailPage(c),
    [at(paths.edit)]: web.editPage(c),
    // English only for now (AGENTS.md): the app loads every locales/en/*.json.
    [at('locales/en/' + c.t.plural + '.json')]:
      JSON.stringify(web.texts(c), null, 2) + '\n',
  };
}

/** Formatted as the repository's Prettier config says, so the files pass `prettier --check` as written. */
async function pretty(path, text) {
  const config = (await resolveConfig(posix.join(process.cwd(), path))) ?? {};
  return format(text, { ...config, filepath: path });
}

/** `FeatureModule` in the app module's imports, as `nest g module` adds one (@nestjs/schematics). */
async function addToAppModule(tree, c, logger) {
  const appModule = posix.join(c.sourceRoot, 'app.module.ts');
  const symbol = c.t.Plural + 'Module';
  if (!tree.exists(appModule)) {
    logger.warn(
      appModule + ' not found: add ' + symbol + ' to your root module by hand.',
    );
    return null;
  }
  const content = tree.read(appModule).toString('utf8');
  const declared = new ModuleDeclarator().declare(content, {
    metadata: 'imports',
    name: c.t.plural + '.module',
    className: symbol,
    path: '/' + c.dir,
    module: '/' + appModule,
    isEsm: true,
  });
  tree.overwrite(appModule, await pretty(appModule, declared));
  return appModule;
}

/** The schematic's factory (collection.json). */
export function feature(options) {
  return async (tree, schematic) => {
    const c = context(options);
    const all = files(c);
    for (const path of Object.keys(all)) {
      if (tree.exists(path)) throw new Error(path + ' exists already.');
    }
    for (const [path, text] of Object.entries(all))
      tree.create(path, await pretty(path, text));
    const changed = options.skipImport
      ? null
      : await addToAppModule(tree, c, schematic.logger);
    const fixture = !c.dir.startsWith(c.sourceRoot + '/');
    // `pnpm --filter api` runs in the API's folder, from the root or from
    // apps/api alike: paths in its commands are relative to that folder.
    const inApi = posix.relative(posix.dirname(c.sourceRoot), c.dir);
    schematic.logger.info(
      [
        '',
        'Next:',
        '  pnpm --filter api ' +
          (fixture ? 'db:generate:fixtures' : 'db:generate') +
          ' --name ' +
          c.t.plural +
          '   # the ' +
          c.t.table +
          " table's migration",
        '  Business logic: ' +
          c.dir +
          '/' +
          c.t.plural +
          '.service.ts, where it says "Business logic" (README.md there lists the rest).',
        '  Texts: ' +
          c.dir +
          '/i18n/en.json. Test: pnpm --filter api test:e2e ' +
          inApi +
          '/' +
          c.t.plural +
          '.e2e-spec.ts',
        ...(changed
          ? []
          : options.skipImport
            ? ['  Not added to the app module (--skip-import).']
            : []),
      ].join('\n'),
    );
  };
}
