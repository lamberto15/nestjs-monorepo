import { empty, runner } from '../../../test/schematic.js';

/** What `--addons sequences` adds to a generated feature (sequences.addon.js). */
describe('the sequences add-on of the feature generator', () => {
  it('numbers the records: the import, the columns and the body', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'invoices',
        fields: 'title:string,total:money',
        addons: 'sequences',
        skipImport: true,
      },
      empty(),
    );
    expect(
      tree.readContent('/src/features/invoices/invoices.module.ts'),
    ).toContain('SequencesModule.forRecord(INVOICE)');
    expect(
      tree.readContent('/src/features/invoices/invoices.tables.ts'),
    ).toContain('recordTable(INVOICE, { columns: numberColumns() })');
    expect(
      tree.readContent('/src/features/invoices/invoice.schemas.ts'),
    ).toContain('body: { ...NUMBER_BODY }');
  });

  it('numbers a `!numbered` field of its own instead, with no number column, and takes the add-on for it', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'accounts',
        fields: 'name:string,reference:string!numbered',
        addons: '',
        skipImport: true,
        webRoot: 'web',
      },
      empty(),
    );
    const at = (file: string) =>
      tree.readContent('/src/features/accounts/' + file);
    expect(at('accounts.module.ts')).toContain(
      "SequencesModule.forRecord(ACCOUNT, undefined, { field: 'reference' })",
    );
    expect(at('account.record.ts')).toContain(
      'reference: field.string().unique().optional()',
    );
    expect(at('accounts.tables.ts')).toContain('recordTable(ACCOUNT)');
    expect(at('account.schemas.ts')).toContain('body: { ...NUMBER_BODY }');
    expect(at('account.schemas.ts')).not.toContain('NUMBER_RESPONSE');
    expect(at('accounts.e2e-spec.ts')).toContain(
      'create({ reference: undefined })',
    );
    const texts = JSON.parse(tree.readContent('/web/locales/en/accounts.json'));
    expect(texts.fields).not.toHaveProperty('number');
    expect(texts.form.referenceHint).toMatch(/empty/);
  });

  it.each([
    ['reference:int!numbered', 'applies to a string field'],
    ['reference:string?!numbered', 'applies to a string field'],
    ['a:string!numbered,b:string!numbered', 'one field at most'],
  ])('refuses %s', async (fields, message) => {
    await expect(
      runner.runSchematic(
        'feature',
        { name: 'accounts', fields: 'name:string,' + fields, skipImport: true },
        empty(),
      ),
    ).rejects.toThrow(message);
  });
});
