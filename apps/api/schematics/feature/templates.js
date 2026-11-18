// The files of a generated feature, in the shape of the records engine's
// reference (test/fixtures/test-items; modules/records/README.md, "Writing a
// feature"), each a function of the generation's context (index.js). The
// schematic formats them with Prettier, so these strings need only be valid
// TypeScript.

import { titleField } from './fields.js';
import { ADDONS, BOOT } from './addons.js';
import { label } from './names.js';

/** Import lines from [name, module] pairs, grouped by module, in first-seen order. */
function importLines(entries, typeOnly = new Set()) {
  const byModule = new Map();
  for (const [name, from] of entries) {
    if (!byModule.has(from)) byModule.set(from, []);
    const names = byModule.get(from);
    if (!names.includes(name)) names.push(name);
  }
  return [...byModule]
    .map(([from, names]) => {
      const all = names.every((n) => typeOnly.has(n));
      const list = names.map((n) =>
        !all && typeOnly.has(n) ? 'type ' + n : n,
      );
      return (
        'import ' +
        (all ? 'type ' : '') +
        '{ ' +
        list.join(', ') +
        " } from '" +
        from +
        "';"
      );
    })
    .join('\n');
}

/** A module path under src, from the feature's folder. */
const src = (c, path) => (path.startsWith('node:') ? path : c.src + '/' + path);

/** The pieces the chosen add-ons give one key (body, response, columns). */
function pieces(c, key) {
  const out = [];
  for (const name of c.addons) {
    const value = ADDONS[name][key];
    if (!value) continue;
    out.push(
      ...(typeof value === 'function'
        ? value(c)
        : Array.isArray(value)
          ? value
          : Object.keys(value)),
    );
  }
  return out;
}

/** The imports the pieces of one key need. */
function pieceImports(c, key) {
  const entries = [];
  for (const name of c.addons) {
    const addon = ADDONS[name];
    if (!addon[key]) continue;
    if (key === 'columns') {
      for (const [n, from] of Object.entries(addon.columns))
        entries.push([n, src(c, from)]);
      continue;
    }
    const used = typeof addon[key] === 'function' ? addon[key](c) : addon[key];
    for (const piece of used) {
      const ident = piece.match(/^[A-Za-z_]+/)[0];
      if (addon.imports[ident])
        entries.push([ident, src(c, addon.imports[ident])]);
      for (const [n, from] of Object.entries(addon.own?.(c) ?? {}))
        if (piece.includes(n)) entries.push([n, from]);
    }
  }
  return entries;
}

const camel = (kebab) =>
  kebab.replace(/-([a-z0-9])/g, (_, l) => l.toUpperCase());
const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** A field as its declaration (modules/fields): field.money().optional(). */
function builder(c, f) {
  const call =
    f.type === 'enum'
      ? 'field.enum([' + f.values.map((v) => "'" + v + "'").join(', ') + '])'
      : f.type === 'ref'
        ? f.ref === c.t.plural
          ? 'field.ref((): Referenced => recordTableOf(' + c.R + '))'
          : 'field.ref(() => ' + camel(f.ref) + ')'
        : 'field.' + f.type + '()';
  return [
    call,
    f.unique ? '.unique()' : '',
    f.optional ? '.optional()' : '',
    f.type === 'string' || f.type === 'text' ? '.searchable()' : '',
  ].join('');
}

export function record(c) {
  const { t } = c;
  const self = c.fields.some((f) => f.ref === t.plural);
  const others = [
    ...new Set(
      c.fields.filter((f) => f.ref && f.ref !== t.plural).map((f) => f.ref),
    ),
  ];
  const imports = [
    ['field', src(c, 'modules/fields/field.js')],
    ...(self ? [['Referenced', src(c, 'modules/fields/field.js')]] : []),
    ['defineRecord', src(c, 'modules/records/record.js')],
    ...(self
      ? [['recordTableOf', src(c, 'modules/records/record-relations.js')]]
      : []),
    ...others.map((ref) => [
      camel(ref),
      '../' + ref + '/' + ref + '.tables.js',
    ]),
  ];
  const options = [
    "subject: '" + t.Singular + "'",
    "path: '" + t.plural + "'",
    "noun: '" + t.noun + "'",
    "table: '" + t.table + "'",
    'softDelete: ' + c.softDelete,
    'unit: ' + c.unit,
    ...(c.clientAccess ? ["clientAccess: 'own'"] : []),
    ...(c.grants === 'none' ? ["grants: 'none'"] : []),
    ...(c.idempotency ? ["idempotency: '" + c.idempotency + "'"] : []),
  ];
  return (
    importLines(imports, new Set(['Referenced'])) +
    '\n\n' +
    '/**\n * ' +
    cap(t.nouns) +
    ': their fields, recycle bin and units, declared once. The\n' +
    ' * table, schemas, list, permissions, policy, store and presenter are\n' +
    ' * derived from it (modules/records). Change a field here, then run\n' +
    ' * drizzle-kit generate for its migration.\n */\n' +
    'export const ' +
    c.R +
    ' = defineRecord({\n' +
    options.join(',\n') +
    ',\nfields: {\n' +
    c.fields
      .map(
        (f) =>
          (f.markdown
            ? '// Markdown: the web app edits it with the Markdown editor and shows it rendered.\n'
            : '') +
          f.name +
          ': ' +
          builder(c, f) +
          ',',
      )
      .join('\n') +
    '\n},\n});\n'
  );
}

export function tables(c) {
  const { t } = c;
  const columns = pieces(c, 'columns');
  const arg =
    columns.length === 0
      ? ''
      : columns.length === 1
        ? ', { columns: ' + columns[0] + '() }'
        : ', { columns: { ' +
          columns.map((n) => '...' + n + '()').join(', ') +
          ' } }';
  return (
    importLines([
      ['recordTable', src(c, 'modules/records/record.js')],
      ...pieceImports(c, 'columns'),
      [c.R, './' + t.singular + '.record.js'],
    ]) +
    '\n\n' +
    '/** ' +
    cap(t.nouns) +
    ': the table ' +
    t.singular +
    '.record.ts declares' +
    (columns.length ? ', with the columns its add-ons keep' : '') +
    '. */\n' +
    'export const ' +
    c.T +
    ' = recordTable(' +
    c.R +
    arg +
    ');\n'
  );
}

export function schemas(c) {
  const { t } = c;
  const body = pieces(c, 'body');
  const response = pieces(c, 'response');
  const spread = (list) => '{ ' + list.map((p) => '...' + p).join(', ') + ' }';
  const parts = [
    ...(body.length ? ['body: ' + spread(body)] : []),
    ...(response.length ? ['response: ' + spread(response)] : []),
  ];
  return (
    importLines(
      [
        ['z', 'zod'],
        ['recordSchemas', src(c, 'modules/records/record.schemas.js')],
        ...pieceImports(c, 'body'),
        ...pieceImports(c, 'response'),
        [c.R, './' + t.singular + '.record.js'],
        [c.T, './' + t.plural + '.tables.js'],
      ],
      new Set(['z', c.T]),
    ) +
    '\n\n' +
    "/**\n * The API's schemas of " +
    t.nouns +
    ', from ' +
    t.singular +
    '.record.ts' +
    (parts.length
      ? ',\n * with what its add-ons read from the bodies and show'
      : '') +
    '.\n */\n' +
    'export const ' +
    c.R +
    '_SCHEMAS = recordSchemas(' +
    c.R +
    (parts.length ? ', { ' + parts.join(', ') + ' }' : '') +
    ');\n' +
    'export type Create' +
    t.Singular +
    'Dto = z.infer<typeof ' +
    c.R +
    '_SCHEMAS.create>;\n' +
    'export type Update' +
    t.Singular +
    'Dto = z.infer<typeof ' +
    c.R +
    '_SCHEMAS.update>;\n\n' +
    '/** ' +
    cap(t.aNoun) +
    ' as stored; the API shows it through RecordPresenter. */\n' +
    'export type ' +
    t.Singular +
    ' = typeof ' +
    c.T +
    '.$inferSelect;\n'
  );
}

export function list(c) {
  const { t } = c;
  return (
    importLines([
      ['recordList', src(c, 'modules/records/record.list.js')],
      [c.R, './' + t.singular + '.record.js'],
      [c.T, './' + t.plural + '.tables.js'],
    ]) +
    '\n\n' +
    '/** What GET /' +
    t.plural +
    ' is filtered, sorted and narrowed by: from ' +
    t.singular +
    '.record.ts. */\n' +
    'export const ' +
    c.R +
    '_LIST = recordList(' +
    c.R +
    ', ' +
    c.T +
    ');\n'
  );
}

export function permissions(c) {
  const { t } = c;
  return (
    importLines([
      ['recordPermissions', src(c, 'modules/records/record.permissions.js')],
      [c.R, './' + t.singular + '.record.js'],
      [c.T, './' + t.plural + '.tables.js'],
    ]) +
    '\n\n' +
    '/**\n * What can be done with ' +
    t.nouns +
    ': the standard actions, conditions and\n' +
    " * seed roles' grants from " +
    t.singular +
    '.record.ts. Business logic: fields\n' +
    ' * granted one by one (`fields`), conditions and actions of its own.\n */\n' +
    'export const ' +
    c.R +
    '_PERMISSIONS = recordPermissions(' +
    c.R +
    ', ' +
    c.T +
    ');\n'
  );
}

export function policy(c) {
  const { t } = c;
  return (
    importLines([
      ['Policy', '@nestjs/authorization'],
      ['RecordPolicy', src(c, 'modules/records/record.policy.js')],
    ]) +
    '\n\n' +
    '/**\n * Who may do what with ' +
    t.aNoun +
    ': each action checked against the row\n' +
    " * (RecordPolicy). Business logic: an ability of the feature's own goes here.\n */\n" +
    '@Policy()\nexport class ' +
    t.Singular +
    'Policy extends RecordPolicy {}\n'
  );
}

export function service(c) {
  const { t } = c;
  const S = t.Singular;
  return (
    importLines(
      [
        ['Injectable', '@nestjs/common'],
        ['List', src(c, 'core/http/list-query.js')],
        ['ListQuery', src(c, 'core/http/list-query.js')],
        ['Principal', src(c, 'iam/auth/principal.js')],
        ['recordValues', src(c, 'modules/records/record.js')],
        ['CurrentCheck', src(c, 'modules/records/record.store.js')],
        ['RecordLookup', src(c, 'modules/records/record.store.js')],
        ['RecordStore', src(c, 'modules/records/record.store.js')],
        [c.R, './' + t.singular + '.record.js'],
        ['Create' + S + 'Dto', './' + t.singular + '.schemas.js'],
        [S, './' + t.singular + '.schemas.js'],
        ['Update' + S + 'Dto', './' + t.singular + '.schemas.js'],
      ],
      new Set([
        'List',
        'ListQuery',
        'Principal',
        'CurrentCheck',
        'RecordLookup',
        'Create' + S + 'Dto',
        S,
        'Update' + S + 'Dto',
      ]),
    ) +
    '\n\n' +
    '/**\n * ' +
    cap(t.nouns) +
    ': the use cases. RecordStore does what the declaration decides\n' +
    ' * (owner, unit, recycle bin) and what every write causes in its transaction\n' +
    " * (the add-ons' hooks, the audit entry, the domain event). Business logic\n" +
    ' * goes where the comments say so. Logic that must hold for every write,\n' +
    ' * whoever makes it (bulk, imports, automations), is a `@RecordExtension()`\n' +
    ' * provider of this feature instead (modules/records/README.md, step 7).\n */\n' +
    '@Injectable()\nexport class ' +
    t.Plural +
    'Service {\n' +
    'constructor(private readonly records: RecordStore<' +
    S +
    '>) {}\n\n' +
    "/** `dto` goes along as `input`: the add-ons' hooks read their keys from it. */\n" +
    'create(owner: Principal, dto: Create' +
    S +
    'Dto) {\n' +
    '// Business logic: check or derive values before the write.\n' +
    'return this.records.create(owner, recordValues(' +
    c.R +
    ', dto), { input: dto });\n}\n\n' +
    'findOne(id: string, lookup?: RecordLookup) {\nreturn this.records.findOne(id, lookup);\n}\n\n' +
    'findPage(user: Principal, list: List, query: ListQuery) {\nreturn this.records.findPage(user, list, query);\n}\n\n' +
    'update(by: Principal, id: string, dto: Update' +
    S +
    'Dto, check?: CurrentCheck<' +
    S +
    '>) {\n' +
    '// Business logic: what a change must respect, in `check` (on the locked row) or here.\n' +
    'return this.records.update(by, id, recordValues(' +
    c.R +
    ', dto), { check, input: dto });\n}\n\n' +
    'delete(by: Principal, id: string, check?: CurrentCheck<' +
    S +
    '>) {\n' +
    'return this.records.delete(by, id, { check });\n}\n}\n'
  );
}

export function controller(c) {
  const { t } = c;
  const S = t.Singular;
  const P = S + 'Policy';
  const m = t.pluralCamel;
  return (
    importLines(
      [
        ...[
          'Body',
          'Controller',
          'Delete',
          'Get',
          'Headers',
          'HttpCode',
          'HttpStatus',
          'Param',
          'ParseUUIDPipe',
          'Patch',
          'Post',
          'Query',
        ].map((n) => [n, '@nestjs/common']),
        ['CurrentUser', '@nestjs/authentication'],
        ['AuthorizationService', '@nestjs/authorization'],
        ['Can', '@nestjs/authorization'],
        ...[
          'ApiBearerAuth',
          'ApiCookieAuth',
          'ApiCreatedResponse',
          'ApiForbiddenResponse',
          'ApiHeader',
          'ApiNoContentResponse',
          'ApiNotFoundResponse',
          'ApiOkResponse',
          'ApiOperation',
          'ApiPreconditionFailedResponse',
          'ApiQuery',
          'ApiTags',
          'ApiUnauthorizedResponse',
        ].map((n) => [n, '@nestjs/swagger']),
        ...[
          'assertUnchanged',
          'Etag',
          'ifMatchHeader',
          'ifNoneMatchHeader',
        ].map((n) => [n, src(c, 'core/http/etag.js')]),
        ['ApiListQuery', src(c, 'core/http/list-docs.js')],
        ['pageSchema', src(c, 'core/http/pagination.js')],
        ['AccessService', src(c, 'iam/access/access.service.js')],
        ['RequestPrincipal', src(c, 'iam/auth/principal.js')],
        ...[
          'IncludePipe',
          'includeQuery',
          'RecordInclude',
          'RecordPresenter',
        ].map((n) => [n, src(c, 'modules/records/record.presenter.js')]),
        ...['assertWritableFields', 'deleteDocs', 'RecordIdempotent'].map(
          (n) => [n, src(c, 'modules/records/record.routes.js')],
        ),
        [c.R + '_LIST', './' + t.singular + '.list.js'],
        [P, './' + t.singular + '.policy.js'],
        [c.R, './' + t.singular + '.record.js'],
        [c.R + '_SCHEMAS', './' + t.singular + '.schemas.js'],
        ['Create' + S + 'Dto', './' + t.singular + '.schemas.js'],
        ['Update' + S + 'Dto', './' + t.singular + '.schemas.js'],
        [t.Plural + 'Service', './' + t.plural + '.service.js'],
      ],
      new Set([
        'RequestPrincipal',
        'RecordInclude',
        'Create' + S + 'Dto',
        'Update' + S + 'Dto',
      ]),
    ) +
    '\n\n' +
    'const SCHEMAS = ' +
    c.R +
    '_SCHEMAS;\n\n' +
    '/**\n * ' +
    cap(t.nouns) +
    ': the HTTP routes only. One the caller may not read is the\n' +
    ' * 404 of a missing one; one they read but may not change, a 403. The\n' +
    " * restore route and the add-ons' routes come with the module's imports.\n */\n" +
    "@ApiTags('" +
    t.plural +
    "')\n@ApiBearerAuth('api-key')\n@ApiBearerAuth('user-token')\n@ApiCookieAuth('user-session')\n" +
    "@ApiUnauthorizedResponse({ description: 'No valid API key or session.' })\n" +
    "@ApiForbiddenResponse({ description: 'Not allowed by your permissions.' })\n" +
    "@Controller('" +
    t.plural +
    "')\nexport class " +
    t.Plural +
    'Controller {\n' +
    'constructor(\nprivate readonly ' +
    m +
    ': ' +
    t.Plural +
    'Service,\nprivate readonly access: AccessService,\nprivate readonly authorization: AuthorizationService,\nprivate readonly presenter: RecordPresenter,\n) {}\n\n' +
    '@Post()\n@Etag()\n@RecordIdempotent(' +
    c.R +
    ')\n@Can(' +
    P +
    ", 'create')\n" +
    "@ApiOperation({ summary: 'Create " +
    t.aNoun +
    "' })\n@ApiCreatedResponse({ standardSchema: SCHEMAS.response })\n" +
    'async create(\n@CurrentUser() user: RequestPrincipal,\n@Body({ schema: SCHEMAS.create }) dto: Create' +
    S +
    'Dto,\n) {\n' +
    "await assertWritableFields(this.access, user, 'create', " +
    c.R +
    ', dto);\n' +
    'return this.presenter.one(user, await this.' +
    m +
    '.create(user, dto));\n}\n\n' +
    '@Get()\n@Etag()\n@Can.Anyone() // Only those the caller may read: filtered in the query.\n' +
    "@ApiOperation({ summary: 'The " +
    t.nouns +
    " you may read, newest first' })\n" +
    '@ApiOkResponse({ standardSchema: pageSchema(SCHEMAS.response) })\n@ApiListQuery(' +
    c.R +
    '_LIST)\n@ApiQuery(includeQuery())\n' +
    "async list(\n@CurrentUser() user: RequestPrincipal,\n@Query() raw: Record<string, unknown>,\n@Query('include', IncludePipe) include: RecordInclude,\n) {\n" +
    'const { list, query } = await this.presenter.query(user, raw);\n' +
    'const page = await this.' +
    m +
    '.findPage(user, list, query);\n' +
    'return this.presenter.page(user, page, { list, query, include });\n}\n\n' +
    "@Get(':id')\n@Etag()\n@Can.Anyone() // Checked below, on the record itself.\n" +
    "@ApiOperation({ summary: 'One " +
    t.noun +
    "' })\n@ApiHeader(ifNoneMatchHeader())\n@ApiQuery(includeQuery())\n" +
    '@ApiOkResponse({ standardSchema: SCHEMAS.response })\n@ApiNotFoundResponse()\n' +
    "async get(\n@CurrentUser() user: RequestPrincipal,\n@Param('id', ParseUUIDPipe) id: string,\n@Query('include', IncludePipe) include: RecordInclude,\n) {\n" +
    'const row = await this.' +
    m +
    '.findOne(id, { visibleTo: user });\n' +
    'await this.authorization.authorize(' +
    P +
    ", 'read', user, row);\n" +
    'return this.presenter.one(user, row, include);\n}\n\n' +
    "@Patch(':id')\n@Etag()\n@Can.Anyone() // Checked below, on the record and on each field.\n" +
    "@ApiOperation({ summary: 'Change " +
    t.aNoun +
    ": only what is sent changes' })\n@ApiHeader(ifMatchHeader())\n" +
    "@ApiOkResponse({ standardSchema: SCHEMAS.response })\n@ApiNotFoundResponse()\n@ApiPreconditionFailedResponse({ description: 'It changed since you read it.' })\n" +
    "async update(\n@CurrentUser() user: RequestPrincipal,\n@Param('id', ParseUUIDPipe) id: string,\n@Body({ schema: SCHEMAS.update }) dto: Update" +
    S +
    "Dto,\n@Headers('if-match') ifMatch: string | undefined,\n) {\n" +
    'await this.' +
    m +
    '.findOne(id, { visibleTo: user });\n' +
    'const updated = await this.' +
    m +
    '.update(user, id, dto, async (row) => {\n' +
    'await this.authorization.authorize(' +
    P +
    ", 'update', user, row);\n" +
    "await assertWritableFields(this.access, user, 'update', " +
    c.R +
    ', dto, row);\n' +
    'assertUnchanged(ifMatch, await this.presenter.one(user, row));\n});\n' +
    'return this.presenter.one(user, updated);\n}\n\n' +
    "@Delete(':id')\n@HttpCode(HttpStatus.NO_CONTENT)\n@Can.Anyone() // Checked below, on the record itself.\n" +
    '@ApiOperation(deleteDocs(' +
    c.R +
    '))\n@ApiHeader(ifMatchHeader())\n@ApiNoContentResponse()\n@ApiNotFoundResponse()\n' +
    "async delete(\n@CurrentUser() user: RequestPrincipal,\n@Param('id', ParseUUIDPipe) id: string,\n@Headers('if-match') ifMatch: string | undefined,\n) {\n" +
    'await this.' +
    m +
    '.findOne(id, { visibleTo: user });\n' +
    'await this.' +
    m +
    '.delete(user, id, async (row) => {\n' +
    'await this.authorization.authorize(' +
    P +
    ", 'delete', user, row);\n" +
    'assertUnchanged(ifMatch, await this.presenter.one(user, row));\n});\n}\n}\n'
  );
}

export function moduleFile(c) {
  const { t } = c;
  const addonImports = [];
  const calls = [];
  const providers = [];
  for (const name of c.addons) {
    const addon = ADDONS[name];
    const call = addon.call(c);
    const own = addon.providers?.(c) ?? [];
    for (const [ident, from] of Object.entries(addon.imports)) {
      if (call.includes(ident + '.') || call.includes(ident + '('))
        addonImports.push([ident, src(c, from)]);
    }
    for (const [ident, from] of Object.entries(addon.own?.(c) ?? {})) {
      if (call.includes(ident) || own.includes(ident))
        addonImports.push([ident, from]);
    }
    if (addon.tableImport)
      addonImports.push([c.T, './' + t.plural + '.tables.js']);
    calls.push(
      (addon.comment ? '// ' + addon.comment + '\n' : '') + call + ',',
    );
    providers.push(...own);
  }
  return (
    importLines([
      ...addonImports.filter(([, from]) => from.startsWith('node:')),
      ['Module', '@nestjs/common'],
      ['AccessModule', src(c, 'iam/access/access.module.js')],
      ['RecordsModule', src(c, 'modules/records/records.module.js')],
      ...addonImports.filter(([, from]) => !from.startsWith('node:')),
      [c.R + '_LIST', './' + t.singular + '.list.js'],
      [c.R + '_PERMISSIONS', './' + t.singular + '.permissions.js'],
      [t.Singular + 'Policy', './' + t.singular + '.policy.js'],
      [c.R, './' + t.singular + '.record.js'],
      [c.R + '_SCHEMAS', './' + t.singular + '.schemas.js'],
      [t.Plural + 'Controller', './' + t.plural + '.controller.js'],
      [t.Plural + 'Service', './' + t.plural + '.service.js'],
      [c.T, './' + t.plural + '.tables.js'],
    ]) +
    '\n\n' +
    '/**\n * ' +
    cap(t.nouns) +
    ': their permissions, their record (store, presenter,\n' +
    ' * restore route, registration), the routes' +
    (c.addons.length
      ? ', and each add-on one\n * import (modules/records/README.md, "Writing an add-on")'
      : '') +
    '.\n */\n' +
    '@Module({\nimports: [\nAccessModule.forFeature(' +
    c.R +
    '_PERMISSIONS),\n' +
    'RecordsModule.forFeature(' +
    c.R +
    ', { table: ' +
    c.T +
    ', list: ' +
    c.R +
    '_LIST, schemas: ' +
    c.R +
    '_SCHEMAS, policy: ' +
    t.Singular +
    'Policy }),\n' +
    calls.join('\n') +
    '\n],\n' +
    'controllers: [' +
    t.Plural +
    'Controller],\n' +
    'providers: [' +
    [t.Plural + 'Service', t.Singular + 'Policy', ...providers].join(', ') +
    '],\n})\n' +
    'export class ' +
    t.Plural +
    'Module {}\n'
  );
}

/** The effect of each approvable action (modules/approvals). */
export function approvalsFile(c) {
  return (
    importLines(
      [
        ['Injectable', '@nestjs/common'],
        ['ApprovalEffect', src(c, 'modules/approvals/approvals.registry.js')],
        [
          'ApprovalEffectHandler',
          src(c, 'modules/approvals/approvals.registry.js'),
        ],
      ],
      new Set(['ApprovalEffectHandler']),
    ) +
    '\n' +
    c.approvals
      .map(
        (a) =>
          '\n/**\n * What `' +
          a.action +
          '` does once it is applied: at once while its approval is\n' +
          ' * off (the setting `' +
          c.t.pluralCamel +
          '.' +
          a.action +
          'Approval`), else once approved.\n */\n' +
          "@ApprovalEffect({ subject: '" +
          c.t.Singular +
          "', action: '" +
          a.action +
          "' })\n@Injectable()\n" +
          'export class ' +
          a.className +
          ' implements ApprovalEffectHandler {\n' +
          'apply(): Promise<void> {\n' +
          '// Business logic: what "' +
          a.label +
          '" does to the record, from\n' +
          '// `apply(applied: ApprovalApplied)` (`applied.id`, `applied.actor`), through its\n' +
          "// store: `records.of('" +
          c.t.Singular +
          "').store.update(applied.actor, applied.id, { … })`\n" +
          '// (Records, modules/records). It may run more than once: make it idempotent.\n' +
          'return Promise.resolve();\n}\n}\n',
      )
      .join('')
  );
}

/** The record's computed fields (modules/computed-fields). */
export function computedFile(c) {
  const title = titleField(c.fields);
  const entry = title
    ? title.name + "Length: computed.int('length(" + title.name + ")')"
    : "edited: computed.bool('updatedAt != createdAt')";
  return (
    importLines([
      ['computed', src(c, 'modules/computed-fields/computed-fields.js')],
      ['defineComputed', src(c, 'modules/computed-fields/computed-fields.js')],
      [c.R, './' + c.t.singular + '.record.js'],
    ]) +
    '\n\n' +
    '/**\n * Values derived from ' +
    c.t.aNoun +
    "'s fields on every read, never stored.\n" +
    ' * Business logic: the computed fields (expressions of modules/expressions).\n */\n' +
    'export const ' +
    c.R +
    '_COMPUTED = defineComputed(' +
    c.R +
    ', {\n' +
    entry +
    ',\n});\n'
  );
}

/** The choices of its first enum field (modules/choices). */
export function choicesFile(c) {
  const f = c.enumField;
  const key = c.t.singular + '-' + c.kebab(f.name);
  return (
    importLines(
      [
        ['Injectable', '@nestjs/common'],
        ['ChoiceProvider', src(c, 'modules/choices/choices.registry.js')],
        ['ChoiceSet', src(c, 'modules/choices/choices.registry.js')],
        ['ChoiceSource', src(c, 'modules/choices/choices.registry.js')],
      ],
      new Set(['ChoiceProvider', 'ChoiceSet']),
    ) +
    '\n\n' +
    '/** The values of `' +
    f.name +
    '` (' +
    c.t.singular +
    '.record.ts). */\n' +
    'const VALUES: readonly string[] = [' +
    f.values.map((v) => "'" + v + "'").join(', ') +
    '];\n\n' +
    '/**\n * The ' +
    label(f.name).toLowerCase() +
    ' a writer may pick: every value of the field.\n' +
    ' * Business logic: narrow them by `principal` or by a parent field (`params`).\n */\n' +
    '@ChoiceSource()\n@Injectable()\nexport class ' +
    c.t.Singular +
    'Choices implements ChoiceProvider {\n' +
    "readonly key = '" +
    key +
    "';\n" +
    "readonly label = '" +
    cap(c.t.noun) +
    ' ' +
    label(f.name).toLowerCase() +
    "';\n" +
    'readonly params = {};\n' +
    'mayUse = () => Promise.resolve(true);\n' +
    'options = () => Promise.resolve(VALUES.map((value) => ({ value, label: value })));\n' +
    'has = ({ value }: { value: string }) => Promise.resolve(VALUES.includes(value));\n}\n\n' +
    '/** The fields chosen together: `ChoicesModule.forRecord(' +
    c.R +
    ', ' +
    c.R +
    '_CHOICES)`. */\n' +
    'export const ' +
    c.R +
    '_CHOICES: ChoiceSet = {\n' +
    "key: '" +
    key +
    "',\nlabel: '" +
    label(f.name) +
    "',\n" +
    'fields: { ' +
    f.name +
    ": { provider: '" +
    key +
    "' } },\n};\n"
  );
}

/** Its PDF's page (modules/documents): Handlebars, wrapped in the module's layout. */
export function documentTemplate(c) {
  return (
    '<!-- ' +
    cap(c.t.aNoun) +
    "'s PDF. Business logic: its layout; the context has\n" +
    '     title, record (field to text), rows and labels (modules/documents). -->\n' +
    '<header>\n  <p class="eyebrow">{{ labels.document }}</p>\n  <h1>{{ title }}</h1>\n</header>\n' +
    '<table class="facts">\n  {{#each rows}}\n  <tr>\n    <th>{{ this.label }}</th>\n    <td>{{ this.value }}</td>\n  </tr>\n  {{/each}}\n</table>\n' +
    '<footer>{{ labels.issued }}</footer>\n'
  );
}

/** Its texts (core/i18n): the permission catalog's. */
export function texts(c) {
  const actions = {
    read: 'See ' + c.t.nouns,
    create: 'Create ' + c.t.nouns,
    update: 'Change ' + c.t.nouns,
    delete: 'Delete ' + c.t.nouns,
    ...(c.softDelete && {
      restore: 'Restore ' + c.t.nouns + ' from the recycle bin',
    }),
    ...(c.addons.includes('shares') && {
      share: 'Share ' + c.t.nouns + ' by a link',
    }),
  };
  return (
    JSON.stringify(
      {
        permissions: {
          [c.kebab(c.t.Singular)]: { label: cap(c.t.nouns), actions },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/** A body's sample value of each type, and another for a change. */
const SAMPLES = {
  string: (f) =>
    f.unique
      ? '`' + label(f.name) + ' ${randomUUID().slice(0, 8)}`'
      : "'" + label(f.name) + "'",
  text: () => "'Some words'",
  int: () => '1',
  decimal: () => "'1.5'",
  money: () => "{ amount: '12.50', currency: 'EUR' }",
  bool: () => 'true',
  date: () => "'2026-01-31'",
  datetime: () => "'2026-01-31T10:00:00.000Z'",
  enum: (f) => "'" + f.values[0] + "'",
  json: () => '{ key: 1 }',
};
const CHANGES = {
  string: () => "'Changed'",
  text: () => "'Other words'",
  int: () => '2',
  decimal: () => "'2.5'",
  money: () => "{ amount: '20.00', currency: 'EUR' }",
  bool: () => 'false',
  date: () => "'2026-02-28'",
  datetime: () => "'2026-02-28T10:00:00.000Z'",
  enum: (f) => "'" + f.values.at(-1) + "'",
  json: () => '{ key: 2 }',
};
const WRONG = { int: "'x'", money: "'x'", bool: "'x'", json: "'x'" };

/** BOOT's order is the dependency order: what is used first. */
const bootOrder = (boot) => Object.keys(BOOT).filter((n) => boot.includes(n));

/** The e2e spec: the generated routes, and one check of each add-on. */
export function e2e(c) {
  const { t } = c;
  const sampled = c.fields.filter((f) => f.type !== 'ref');
  const changed =
    c.fields.find((f) => f.type !== 'ref' && !f.unique) ?? sampled[0];
  const first = sampled[0];
  const boot = bootOrder([
    ...new Set(c.addons.flatMap((name) => ADDONS[name].boot ?? [])),
  ]);
  const env = Object.assign(
    { SCHEDULER: 'off', IDEMPOTENCY: 'optional' },
    ...c.addons.map((name) => ADDONS[name].env ?? {}),
  );
  const needsUuid = sampled.some((f) => f.unique && f.type === 'string');
  const who = c.grants === 'none' ? 'admin' : 'editor';
  const h = 'team.' + who + '.headers';
  const one = '`' + c.url + '/${item.id}`';
  const envLines = Object.entries(env).map(([k, v]) => k + ": '" + v + "'");
  envLines.push(
    'REDIS_PREFIX: `test-' + t.plural + '-${process.pid}-${Date.now()}`',
  );
  return (
    importLines(
      [
        ...(needsUuid ? [['randomUUID', 'node:crypto']] : []),
        ['NestNodeApplication', '@nestjs/platform-node'],
        ['bootModules', c.test + '/boot.js'],
        ['recordsTenant', c.test + '/records.js'],
        ['testItemModules', c.test + '/records.js'],
        ...boot.map((n) => [n, src(c, BOOT[n])]),
        [t.Plural + 'Module', './' + t.plural + '.module.js'],
      ],
      new Set(['NestNodeApplication']),
    ) +
    '\n\n' +
    'vi.hoisted(() => {\nObject.assign(process.env, {\n' +
    envLines.join(',\n') +
    ',\n});\n});\n\n' +
    '/** ' +
    cap(t.nouns) +
    ' (generated): the routes of the record' +
    (c.addons.length ? ', and one check of each add-on it imports' : '') +
    '. */\n' +
    "describe('" +
    t.plural +
    " (e2e)', () => {\n" +
    'let app: NestNodeApplication;\nlet team: Awaited<ReturnType<typeof recordsTenant>>;\n\n' +
    'beforeAll(async () => {\napp = await bootModules(...testItemModules(), ' +
    [...boot, t.Plural + 'Module'].join(', ') +
    ');\n' +
    'team = await recordsTenant(app);\n});\n\nafterAll(async () => {\nawait app?.close();\n});\n\n' +
    "const call = (\nmethod: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',\nurl: string,\nheaders: Record<string, string>,\npayload?: object,\n) => app.inject({ method, url, headers, ...(payload && { payload }) });\n\n" +
    '/** A valid create body. */\nconst sample = () => ({\n' +
    sampled.map((f) => f.name + ': ' + SAMPLES[f.type](f) + ',').join('\n') +
    '\n});\n\n' +
    '/** One of the ' +
    who +
    "'s, as answered: 201 or the test fails. */\n" +
    'const create = async (body: object = {}) => {\n' +
    "const response = await call('POST', '" +
    c.url +
    "', " +
    h +
    ', { ...sample(), ...body });\n' +
    'expect(response.statusCode, response.body).toBe(201);\n' +
    'return response.json<Record<string, unknown> & { id: string }>();\n};\n' +
    "\nit('creates one as its owner, reads it with an ETag and lists it', async () => {\n" +
    'const item = await create();\nexpect(item.ownerId).toBe(`user:${team.' +
    who +
    '.id}`);\n' +
    "const read = await call('GET', " +
    one +
    ', ' +
    h +
    ');\n' +
    'expect(read.statusCode, read.body).toBe(200);\nexpect(read.headers.etag).toBeTruthy();\n' +
    "const page = await call('GET', '" +
    c.url +
    "', " +
    h +
    ');\n' +
    'expect(page.json().items.map((row: { id: string }) => row.id)).toContain(item.id);\n});\n' +
    "\nit('refuses a body its schema refuses (400)', async () => {\n" +
    "const response = await call('POST', '" +
    c.url +
    "', " +
    h +
    ', { ...sample(), ' +
    first.name +
    ': ' +
    (WRONG[first.type] ?? '12345') +
    ' });\n' +
    'expect(response.statusCode, response.body).toBe(400);\n});\n' +
    "\nit('changes only what is sent, and refuses a stale If-Match (412)', async () => {\n" +
    'const item = await create();\n' +
    "const changed = await call('PATCH', " +
    one +
    ', ' +
    h +
    ', { ' +
    changed.name +
    ': ' +
    CHANGES[changed.type](changed) +
    ' });\n' +
    'expect(changed.statusCode, changed.body).toBe(200);\n' +
    'expect(changed.json().' +
    changed.name +
    ').toEqual(' +
    CHANGES[changed.type](changed) +
    ');\n' +
    "const stale = await app.inject({ method: 'PATCH', url: " +
    one +
    ', headers: { ...' +
    h +
    ", 'if-match': '\"stale\"' }, payload: {} });\n" +
    'expect(stale.statusCode, stale.body).toBe(412);\n});\n' +
    "\nit('deletes one" +
    (c.softDelete ? " to the recycle bin, and restores it'" : "'") +
    ', async () => {\n' +
    'const item = await create();\n' +
    "const deleted = await call('DELETE', " +
    one +
    ', ' +
    h +
    ');\n' +
    'expect(deleted.statusCode, deleted.body).toBe(204);\n' +
    "expect((await call('GET', " +
    one +
    ', ' +
    h +
    ')).statusCode).toBe(404);\n' +
    (c.softDelete
      ? "const restored = await call('POST', `" +
        c.url +
        '/${item.id}/restore`, ' +
        h +
        ');\n' +
        'expect(restored.statusCode, restored.body).toBeLessThan(300);\n' +
        "expect((await call('GET', " +
        one +
        ', ' +
        h +
        ')).statusCode).toBe(200);\n'
      : '') +
    '});\n' +
    "\nit('hides it from a member without a role (404)" +
    (c.grants === 'none'
      ? ''
      : '; a viewer reads it but may not change it (403)') +
    "', async () => {\n" +
    'const item = await create();\n' +
    "expect((await call('GET', " +
    one +
    ', team.nobody.headers)).statusCode).toBe(404);\n' +
    (c.grants === 'none'
      ? ''
      : "expect((await call('GET', " +
        one +
        ', team.viewer.headers)).statusCode).toBe(200);\n' +
        "expect((await call('PATCH', " +
        one +
        ', team.viewer.headers, {})).statusCode).toBe(403);\n') +
    '});\n' +
    c.addons.map((name) => ADDONS[name].test(c)).join('\n') +
    '\n});\n'
  );
}

/** Its README: what it is, its routes, where its logic goes. */
export function readme(c) {
  const { t } = c;
  const lines = [
    '# ' + cap(t.nouns),
    '',
    cap(t.nouns) +
      ', generated by the `feature` schematic (docs/adding-a-feature.md): a',
    'record of modules/records, declared in `' + t.singular + '.record.ts`.',
    '',
    '## Routes',
    '',
    '- `POST /v1/' +
      t.plural +
      '`, `GET /v1/' +
      t.plural +
      '`, `GET|PATCH|DELETE /v1/' +
      t.plural +
      '/{id}`' +
      (c.softDelete ? ', `POST /v1/' + t.plural + '/{id}/restore`' : ''),
    '- Permissions on `' +
      t.Singular +
      '`: read, create, update, delete' +
      (c.softDelete ? ', restore' : '') +
      (c.grants === 'none'
        ? ' (only administrators until granted)'
        : ' (editors their own, viewers all' +
          (c.unit ? ", unit leads their units'" : '') +
          ')'),
    '',
  ];
  if (c.addons.length) {
    lines.push(
      '## Add-ons',
      '',
      'Each is one import in `' +
        t.plural +
        '.module.ts`; its README in `src/modules/<name>` has its routes.',
      '',
    );
    for (const name of c.addons)
      lines.push('- ' + name + ': ' + ADDONS[name].about);
    lines.push('');
  }
  lines.push(
    '## Business logic',
    '',
    '- `' +
      t.plural +
      '.service.ts`, where it says "Business logic"; logic of every write in a `@RecordExtension()` provider of this folder.',
    '- `' +
      t.singular +
      '.policy.ts`: abilities of its own; `' +
      t.singular +
      '.permissions.ts`: fields granted one by one, conditions.',
    ...(c.addons.includes('approvals')
      ? [
          '- `' +
            t.singular +
            '.approvals.ts`: what each approvable action does.',
        ]
      : []),
    ...(c.addons.includes('computed-fields')
      ? ['- `' + t.singular + '.computed.ts`: the computed fields.']
      : []),
    ...(c.addons.includes('choices')
      ? ['- `' + t.singular + '.choices.ts`: the choices a writer may pick.']
      : []),
    ...(c.addons.includes('documents')
      ? ['- `templates/' + t.singular + '.html`: the PDF.']
      : []),
    '',
    'Tests: `' +
      t.plural +
      '.e2e-spec.ts`. Remove: delete this folder and its line in `app.module.ts`, then generate the migration that drops its table.',
    '',
  );
  return lines.join('\n');
}
