import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

/**
 * The feature schematic (schematics/feature) on a virtual tree: the files
 * of a feature, the app module's import, the refusals; and the generated
 * fixture (test/fixtures/generated-feature: every add-on, never edited by
 * hand) is exactly what the schematic writes, so it cannot drift from it.
 */

// The devkit is @nestjs/schematics' dependency, not this app's: resolved
// from there (pnpm keeps it out of apps/api/node_modules).
const devkit = createRequire(
  createRequire(import.meta.url).resolve('@nestjs/schematics'),
);
const { SchematicTestRunner, UnitTestTree } = devkit(
  '@angular-devkit/schematics/testing',
) as {
  SchematicTestRunner: new (
    name: string,
    path: string,
  ) => {
    runSchematic(name: string, options: object, tree: unknown): Promise<Tree>;
  };
  UnitTestTree: new (tree: unknown) => Tree;
};
const { Tree: Trees } = devkit('@angular-devkit/schematics') as {
  Tree: { empty(): unknown };
};

interface Tree {
  files: string[];
  readContent(path: string): string;
  create(path: string, content: string): void;
}

const API = join(import.meta.dirname, '..', '..');
const runner = new SchematicTestRunner(
  'feature',
  join(API, 'schematics/collection.json'),
);
const empty = () => new UnitTestTree(Trees.empty());

/** What the fixture was generated with (docs/adding-a-feature.md, "The generated fixture"). */
const FIXTURE = {
  name: 'generated-items',
  path: 'test/fixtures/generated-feature',
  flat: true,
  skipImport: true,
  fields:
    'title:string,body:text?,status:enum(draft|done),amount:money?,dueOn:date?,code:string!unique',
  addons: 'all',
  unit: true,
};

function onDisk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? onDisk(join(dir, entry.name))
      : [join(dir, entry.name)],
  );
}

describe('the feature schematic', () => {
  it('writes the generated fixture as it is on disk, file for file', async () => {
    const tree = await runner.runSchematic('feature', FIXTURE, empty());
    const generated = tree.files.map((file) => file.slice(1)).sort();
    const fixture = onDisk(join(API, FIXTURE.path))
      .map((file) => relative(API, file))
      .sort();
    expect(generated).toEqual(fixture);
    for (const file of generated) {
      expect(tree.readContent('/' + file), file).toBe(
        readFileSync(join(API, file), 'utf8'),
      );
    }
  });

  it('writes the nine files, its texts, spec and README into src/features/<name>, and adds the module to the app module', async () => {
    const tree = empty();
    tree.create(
      'src/app.module.ts',
      "import { Module } from '@nestjs/common';\nimport { TagsModule } from './modules/tags/tags.module.js';\n\n@Module({\n  imports: [TagsModule],\n})\nexport class AppModule {}\n",
    );
    const result = await runner.runSchematic(
      'feature',
      {
        name: 'invoices',
        fields: 'title:string,total:money',
        addons: 'tags,sequences',
      },
      tree,
    );
    expect(
      result.files.filter((file) => file.startsWith('/src/features/')).sort(),
    ).toEqual(
      [
        'README.md',
        'i18n/en.json',
        'invoice.list.ts',
        'invoice.permissions.ts',
        'invoice.policy.ts',
        'invoice.record.ts',
        'invoice.schemas.ts',
        'invoices.controller.ts',
        'invoices.e2e-spec.ts',
        'invoices.module.ts',
        'invoices.service.ts',
        'invoices.tables.ts',
      ].map((file) => '/src/features/invoices/' + file),
    );
    const app = result.readContent('/src/app.module.ts');
    expect(app).toContain(
      "import { InvoicesModule } from './features/invoices/invoices.module.js';",
    );
    expect(app).toContain('imports: [TagsModule, InvoicesModule]');
    const module = result.readContent(
      '/src/features/invoices/invoices.module.ts',
    );
    expect(module).toContain('TagsModule.forRecord(INVOICE)');
    expect(module).toContain('SequencesModule.forRecord(INVOICE)');
    expect(module).toContain("from '../../modules/records/records.module.js'");
    expect(
      result.readContent('/src/features/invoices/invoices.tables.ts'),
    ).toContain('recordTable(INVOICE, { columns: numberColumns() })');
    expect(
      result.readContent('/src/features/invoices/invoice.schemas.ts'),
    ).toContain('body: { ...NUMBER_BODY }');
  });

  it('declares the options it was given: no recycle bin, API clients, no seed grants, idempotency', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'people',
        singular: 'person',
        fields: 'name:string',
        softDelete: false,
        clientAccess: true,
        grants: 'none',
        idempotency: 'required',
        skipImport: true,
      },
      empty(),
    );
    const record = tree.readContent('/src/features/people/person.record.ts');
    expect(record).toContain('softDelete: false');
    expect(record).toContain("clientAccess: 'own'");
    expect(record).toContain("grants: 'none'");
    expect(record).toContain("idempotency: 'required'");
    expect(
      tree.readContent('/src/features/people/people.e2e-spec.ts'),
    ).toContain('team.admin.headers');
  });

  it.each([
    [{ name: 'Invoices', fields: 'title:string' }, 'plural, lowercase'],
    [{ name: 'invoices', fields: '' }, 'at least one field'],
    [{ name: 'invoices', fields: 'title:strin' }, 'not a type'],
    [
      { name: 'invoices', fields: 'title:string', addons: 'tagz' },
      'not an add-on',
    ],
    [
      {
        name: 'invoices',
        fields: 'title:string',
        addons: 'merge',
        softDelete: false,
      },
      'recycle bin',
    ],
    [
      { name: 'invoices', fields: 'title:string', addons: 'choices' },
      'enum field',
    ],
    [
      {
        name: 'invoices',
        fields: 'title:string',
        addons: 'approvals',
        approvals: 'restore',
      },
      'not an action',
    ],
    [{ name: 'tags', fields: 'title:string' }, 'taken'],
  ])('refuses %o before writing anything', async (options, message) => {
    await expect(
      runner.runSchematic('feature', { skipImport: true, ...options }, empty()),
    ).rejects.toThrow(message);
  });
});
