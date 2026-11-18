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
});
