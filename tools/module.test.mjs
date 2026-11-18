import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  applyEdits,
  describe as describePlan,
  list,
  plan,
  resolveName,
  unmark,
} from './module.mjs';

const REPO = path.resolve(import.meta.dirname, '..');
const LEVELS = ['core', 'iam', 'modules', 'features'];

/**
 * A small repository in a temp directory: the real graph and the API's
 * TypeScript (node_modules linked), and three modules: `notes` (used by
 * nothing, with a table, a variable, routes, web pages, a marked block and a
 * doc link), `labels` (used by notes) and `features/invoices`.
 */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'module-')));
  const put = (file, text) => {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  cpSync(
    path.join(REPO, 'apps/api/test/module-graph.ts'),
    path.join(root, 'apps/api/test/module-graph.ts'),
  );
  put('apps/api/package.json', '{ "type": "module" }\n');
  // The compiler, from the real API: its own node_modules.
  mkdirSync(path.join(root, 'apps/api/node_modules'), { recursive: true });
  cpSync(
    path.join(REPO, 'apps/api/node_modules/typescript'),
    path.join(root, 'apps/api/node_modules/typescript'),
    { dereference: true, recursive: true },
  );
  put(
    'apps/api/src/app.module.ts',
    `import { Module } from '@nestjs/common';
import { DatabaseModule } from './core/database/database.module.js';
import { LabelsModule } from './modules/labels/labels.module.js';
import { NotesModule } from './modules/notes/notes.module.js';
import { InvoicesModule } from './features/invoices/invoices.module.js';

@Module({
  imports: [
    DatabaseModule,
    // Labels, then notes.
    LabelsModule,
    NotesModule.forRoot(),
    // Notes, with what they need.
    NotesModule.forFeature(),
    // Business features.
    InvoicesModule,
  ],
})
export class AppModule {}
`,
  );
  put(
    'apps/api/src/core/database/database.module.ts',
    'export class DatabaseModule {}\n',
  );
  put(
    'apps/api/src/modules/labels/labels.module.ts',
    'export class LabelsModule {}\n',
  );
  put(
    'apps/api/src/modules/notes/notes.module.ts',
    "import { LabelsModule } from '../labels/labels.module.js';\nexport class NotesModule {}\n",
  );
  put(
    'apps/api/src/modules/notes/notes.controller.ts',
    "@Controller('notes')\nexport class NotesController {}\n",
  );
  put(
    'apps/api/src/modules/notes/notes.tables.ts',
    "export const notes = tenantTable('notes', {});\nexport const noteKind = pgEnum('note_kind', ['a']);\n",
  );
  put(
    'apps/api/src/modules/notes/notes.config.ts',
    'export const schema = z.object({ NOTES_LIMIT: z.number() });\n',
  );
  put(
    'apps/api/src/modules/notes/README.md',
    '# Notes\n\nWhat they are.\n\nNo variables. Remove: delete this folder and its line in\n`app.module.ts`, and the cache.\n',
  );
  put(
    'apps/api/src/features/invoices/invoices.module.ts',
    'export class InvoicesModule {}\n',
  );
  put(
    'apps/api/env.example',
    '# --- core/database ---\nDATABASE_URL=\n\n# --- modules/notes ---\n# NOTES_LIMIT=10\n',
  );
  put(
    'apps/api/schematics/feature/addons.js',
    "import notes from '../../src/modules/notes/notes.addon.js';\nexport const ADDONS = { notes };\n",
  );
  put(
    'apps/api/src/modules/notes/notes.addon.js',
    "export default { imports: { LabelsModule: 'modules/labels/labels.module.js' } };\n",
  );
  put(
    'packages/api-client/openapi.json',
    JSON.stringify({
      paths: {
        '/v1/notes': { get: { operationId: 'NotesController_list_v1' } },
        '/v1/notes/{id}': {
          delete: { operationId: 'NotesController_remove_v1' },
        },
        '/v1/labels': { get: { operationId: 'LabelsController_list_v1' } },
      },
    }),
  );
  put('apps/web/src/features/notes/api.ts', "api.GET('/v1/notes');\n");
  put(
    'apps/web/src/features/notes/nav.ts',
    "export default { to: '/notes', label: 'notes:nav' };\n",
  );
  put(
    'apps/web/src/routes/_app/notes.tsx',
    // A page's route: the module's page, behind the shared permission gate.
    "import { requirePermission } from '@/features/access/gate';\nimport { NotesPage } from '@/features/notes/notes-page';\n",
  );
  put('apps/web/src/locales/en/notes.json', '{}\n');
  put(
    'apps/web/src/test/server.ts',
    "export const handlers = [\n  // capability:notes begin\n  http.get('/v1/notes', () => ok),\n  // capability:notes end\n  http.get('/v1/labels', () => ok),\n];\n",
  );
  put(
    'docs/identity.md',
    '# Identity\n\n- [notes](../apps/api/src/modules/notes/README.md)\n- See [notes](../apps/api/src/modules/notes/README.md) for the rest.\n',
  );
  put('PORTING.md', '- [x] notes\n- [x] labels\n');
  put(
    'tools/ci/raw-sql.allow.json',
    `${JSON.stringify({ 'apps/api/src/modules/notes/notes.service.ts': { count: 1, why: 'x' } }, null, 2)}\n`,
  );
  return root;
}

describe('module', () => {
  let root;
  before(() => {
    root = fixture();
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('resolves a bare name, a level and refuses core, the unknown and a path', () => {
    assert.equal(resolveName(root, 'notes', LEVELS).id, 'modules/notes');
    assert.equal(
      resolveName(root, 'features/invoices', LEVELS).dir,
      'apps/api/src/features/invoices',
    );
    assert.equal(
      resolveName(root, 'apps/api/src/modules/notes/', LEVELS).id,
      'modules/notes',
    );
    assert.throws(() => resolveName(root, 'database', LEVELS), /is core/);
    assert.throws(() => resolveName(root, 'nothing', LEVELS), /No module/);
    assert.throws(
      () => resolveName(root, '../notes', LEVELS),
      /named by its folder/,
    );
    assert.throws(() => resolveName(root, 'x/notes', LEVELS), /the levels are/);
  });

  it('says a bare name two levels share is ambiguous', () => {
    mkdirSync(path.join(root, 'apps/api/src/iam/invoices'), {
      recursive: true,
    });
    try {
      assert.throws(
        () => resolveName(root, 'invoices', LEVELS),
        /ambiguous: iam\/invoices, features\/invoices/,
      );
    } finally {
      rmSync(path.join(root, 'apps/api/src/iam/invoices'), { recursive: true });
    }
  });

  it('refuses a module another one uses, naming who', async () => {
    const p = await plan(root, 'labels');
    assert.deepEqual(
      p.dependents.map((d) => [d.kind, d.by]),
      [
        ['module', 'modules/notes'],
        ['generator', 'apps/api/src/modules/notes/notes.addon.js'],
      ],
    );
    const text = describePlan(p);
    assert.match(text, /REFUSED: 2 place\(s\) use modules\/labels/);
    assert.match(text, /Remove those first/);
    assert.doesNotMatch(text, /Tables dropped/);
  });

  it('lists every module above core with who uses it', async () => {
    const rows = await list(root);
    assert.deepEqual(
      rows.map((r) => [r.id, r.dependents.length]),
      [
        ['modules/labels', 2],
        ['modules/notes', 0],
        ['features/invoices', 0],
      ],
    );
  });

  it('dry run: says what goes, and changes nothing', async () => {
    const before = readFileSync(
      path.join(root, 'apps/api/src/app.module.ts'),
      'utf8',
    );
    const p = await plan(root, 'notes');
    assert.deepEqual(p.dependents, []);
    const text = describePlan(p);
    for (const expected of [
      "import { NotesModule } from './modules/notes/notes.module.js';",
      'NotesModule.forRoot(),  (imports: [...])',
      'NotesModule.forFeature(),  (imports: [...])',
      '// Notes, with what they need.',
      'notes  (apps/api/src/modules/notes/notes.tables.ts)',
      'note_kind  (apps/api/src/modules/notes/notes.tables.ts)',
      'NOTES_LIMIT',
      'GET /v1/notes',
      'DELETE /v1/notes/{id}',
      'apps/web/src/features/notes/api.ts',
      'apps/web/src/routes/_app/notes.tsx',
      'apps/web/src/locales/en/notes.json',
      'apps/web/src/test/server.ts (1)',
      'apps/api/src/modules/notes/notes.service.ts',
      'docs/identity.md:3 (removed: a line that is only the link)',
      'docs/identity.md:4 (rewrite it)',
      'PORTING.md:1 - [x] notes',
      'Its README: Remove: delete this folder and its line in `app.module.ts`, and the cache.',
    ]) {
      assert.ok(text.includes(expected), `missing: ${expected}\n${text}`);
    }
    assert.doesNotMatch(text, /PORTING.md:2/);
    assert.equal(
      readFileSync(path.join(root, 'apps/api/src/app.module.ts'), 'utf8'),
      before,
    );
  });

  it('applies: the folder, its app.module lines, web files, marked blocks, link lines and allowlist entries', async () => {
    const p = await plan(root, 'notes');
    applyEdits(root, p);
    const read = (file) => readFileSync(path.join(root, file), 'utf8');
    assert.equal(
      read('apps/api/src/app.module.ts'),
      `import { Module } from '@nestjs/common';
import { DatabaseModule } from './core/database/database.module.js';
import { LabelsModule } from './modules/labels/labels.module.js';
import { InvoicesModule } from './features/invoices/invoices.module.js';

@Module({
  imports: [
    DatabaseModule,
    // Labels, then notes.
    LabelsModule,
    // Business features.
    InvoicesModule,
  ],
})
export class AppModule {}
`,
    );
    assert.equal(
      existsSync(path.join(root, 'apps/api/src/modules/notes')),
      false,
    );
    assert.equal(
      existsSync(path.join(root, 'apps/web/src/features/notes')),
      false,
    );
    assert.equal(
      existsSync(path.join(root, 'apps/web/src/routes/_app/notes.tsx')),
      false,
    );
    assert.equal(
      existsSync(path.join(root, 'apps/web/src/locales/en/notes.json')),
      false,
    );
    assert.equal(
      read('apps/web/src/test/server.ts'),
      "export const handlers = [\n  http.get('/v1/labels', () => ok),\n];\n",
    );
    assert.equal(
      read('docs/identity.md'),
      '# Identity\n\n- See [notes](../apps/api/src/modules/notes/README.md) for the rest.\n',
    );
    assert.deepEqual(JSON.parse(read('tools/ci/raw-sql.allow.json')), {});
  });

  it('refuses when app.module.ts names it outside the imports list', async () => {
    const file = path.join(root, 'apps/api/src/app.module.ts');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'export class AppModule {}',
        'export class AppModule {}\nexport const first = InvoicesModule;',
      ),
    );
    const p = await plan(root, 'invoices');
    assert.match(
      p.appModule.problems[0],
      /InvoicesModule used outside the imports list/,
    );
    assert.match(describePlan(p), /REFUSED: app.module.ts names it/);
  });
});

describe('unmark', () => {
  it('drops the blocks of one name, in TypeScript and JSX', () => {
    const text = [
      'a',
      '  // capability:ai begin',
      '  ai: true,',
      '  // capability:ai end',
      '  {/* capability:ai begin */}',
      '  <Ai />',
      '  {/* capability:ai end */}',
      '  // capability:aim begin',
      '  kept',
      '  // capability:aim end',
      'b',
    ].join('\n');
    const { text: out, blocks, problem } = unmark(text, 'ai');
    assert.equal(blocks, 2);
    assert.equal(problem, undefined);
    assert.equal(
      out,
      'a\n  // capability:aim begin\n  kept\n  // capability:aim end\nb',
    );
  });

  it('reports markers that do not pair', () => {
    assert.match(
      unmark('// capability:ai begin\nx', 'ai').problem,
      /without its end/,
    );
    assert.match(
      unmark('x\n// capability:ai end', 'ai').problem,
      /without its begin/,
    );
  });
});
