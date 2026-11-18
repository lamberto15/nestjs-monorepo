import { empty, runner } from '../../../test/schematic.js';

/** What `--addons tags` adds to a generated feature (tags.addon.js). */
describe('the tags add-on of the feature generator', () => {
  it('imports TagsModule.forRecord() and shows the tags with the record', async () => {
    const tree = await runner.runSchematic(
      'feature',
      {
        name: 'invoices',
        fields: 'title:string',
        addons: 'tags',
        skipImport: true,
      },
      empty(),
    );
    expect(
      tree.readContent('/src/features/invoices/invoices.module.ts'),
    ).toContain('TagsModule.forRecord(INVOICE)');
    expect(
      tree.readContent('/src/features/invoices/invoice.schemas.ts'),
    ).toContain('TAGS_RESPONSE');
  });
});
