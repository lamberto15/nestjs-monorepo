import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { empty, runner } from '../schematic.js';

/**
 * The feature schematic (schematics/feature) on a virtual tree: the files
 * of a feature, the app module's import, the refusals; and the generated
 * fixture (test/fixtures/generated-feature: every add-on, never edited by
 * hand) is exactly what the schematic writes, so it cannot drift from it.
 * What one add-on adds is tested beside it (src/modules/<name>/<name>.addon.spec.ts).
 */

const API = join(import.meta.dirname, '..', '..');

/**
 * What the fixture is generated with: written once, read here and by
 * `pnpm module:remove`, which generates it again with the add-ons left.
 */
const FIXTURE = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'generated-feature.options.json'),
    'utf8',
  ),
) as Record<string, string | boolean>;

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
    const fixture = onDisk(join(API, FIXTURE.path as string))
      .map((file) => relative(API, file))
      .sort();
    expect(generated).toEqual(fixture);
    for (const file of generated) {
      expect(tree.readContent('/' + file), file).toBe(
        readFileSync(join(API, file), 'utf8'),
      );
    }
  });

  it('from the repository root with --web-root, also writes the web pages, and the API test helpers stay beside its src', async () => {
    const tree = empty();
    tree.create(
      'apps/api/src/app.module.ts',
      "import { Module } from '@nestjs/common';\n\n@Module({\n  imports: [],\n})\nexport class AppModule {}\n",
    );
    const result = await runner.runSchematic(
      'feature',
      {
        name: 'invoices',
        fields: 'title:string,total:money',
        addons: '',
        sourceRoot: 'apps/api/src',
        webRoot: 'apps/web/src',
      },
      tree,
    );
    expect(
      result.files.filter((file) => file.startsWith('/apps/web/')).sort(),
    ).toEqual(
      [
        'features/invoices/api.ts',
        'features/invoices/invoice-form.tsx',
        'features/invoices/invoices.test.tsx',
        'features/invoices/nav.ts',
        'features/invoices/record-form.tsx',
        'features/invoices/record-link.ts',
        'features/invoices/use-invoice-delete.tsx',
        'locales/en/invoices.json',
        'routes/_app/invoices/$id/edit.tsx',
        'routes/_app/invoices/$id/index.tsx',
        'routes/_app/invoices/index.tsx',
        'routes/_app/invoices/new.tsx',
      ].map((file) => '/apps/web/src/' + file),
    );
    // A bulk run's notification opens the list narrowed to what it changed.
    expect(
      result.readContent('/apps/web/src/routes/_app/invoices/index.tsx'),
    ).toContain('...run.query');
    expect(
      result.readContent('/apps/web/src/features/invoices/api.ts'),
    ).toContain("INVOICES_PATH = '/v1/invoices'");
    expect(
      result.readContent(
        '/apps/api/src/features/invoices/invoices.e2e-spec.ts',
      ),
    ).toContain("from '../../../test/boot.js'");
  });

  it('writes the nine files, its texts, spec and README into src/features/<name>, and adds the module to the app module', async () => {
    const tree = empty();
    tree.create(
      'src/app.module.ts',
      "import { Module } from '@nestjs/common';\nimport { OtherModule } from './modules/other/other.module.js';\n\n@Module({\n  imports: [OtherModule],\n})\nexport class AppModule {}\n",
    );
    const result = await runner.runSchematic(
      'feature',
      { name: 'invoices', fields: 'title:string,total:money', addons: '' },
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
    expect(app).toContain('imports: [OtherModule, InvoicesModule]');
    expect(
      result.readContent('/src/features/invoices/invoices.module.ts'),
    ).toContain("from '../../modules/records/records.module.js'");
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

  it('keeps a field unique within another: `!unique(<field>)`', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'stages',
        fields:
          'name:string,productId:ref(products)?,code:string!unique(productId)',
        skipImport: true,
      },
      empty(),
    );
    expect(tree.readContent('/src/features/stages/stage.record.ts')).toContain(
      "code: field.string().unique({ within: 'productId' })",
    );
  });

  it("names a reference's subject as its target declares it, not by guessing from the plural", async () => {
    const tree = empty();
    tree.create(
      '/src/features/product-statuses/product-status.record.ts',
      "export const PRODUCT_STATUS = defineRecord({ subject: 'ProductStatus', path: 'product-statuses' });\n",
    );
    const result = await runner.runSchematic(
      'feature',
      {
        name: 'tickets',
        fields: 'title:string,statusId:ref(product-statuses)?',
        skipImport: true,
        webRoot: 'web',
      },
      tree,
    );
    const form = result.readContent('/web/features/tickets/ticket-form.tsx');
    expect(form).toContain('subject="ProductStatus"');
    expect(form).not.toContain('ProductStatuse');
  });

  it('declares a member of the tenant: `<name>:user?`', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'cases',
        fields: 'title:string,assigneeId:user?',
        skipImport: true,
      },
      empty(),
    );
    expect(tree.readContent('/src/features/cases/case.record.ts')).toContain(
      'assigneeId: field.user().optional()',
    );
  });

  it.each([
    [{ name: 'cases', fields: 'title:string,assigneeId:user' }, 'is optional'],
    [
      { name: 'stages', fields: 'code:string!unique(productId)' },
      'no other field',
    ],
    [
      { name: 'stages', fields: 'code:string!numbered(productId)' },
      'only !unique takes',
    ],
    [{ name: 'Invoices', fields: 'title:string' }, 'plural, lowercase'],
    [{ name: 'invoices', fields: '' }, 'at least one field'],
    [{ name: 'invoices', fields: 'title:strin' }, 'not a type'],
    [
      { name: 'invoices', fields: 'title:string', addons: 'tagz' },
      'not an add-on',
    ],
    [{ name: 'health', fields: 'title:string' }, 'taken'],
  ])('refuses %o before writing anything', async (options, message) => {
    await expect(
      runner.runSchematic('feature', { skipImport: true, ...options }, empty()),
    ).rejects.toThrow(message);
  });
});
