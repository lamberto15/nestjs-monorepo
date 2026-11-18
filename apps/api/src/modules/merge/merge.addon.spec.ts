import { empty, runner } from '../../../test/schematic.js';

/** What `--addons merge` asks of a generated feature (merge.addon.js). */
describe('the merge add-on of the feature generator', () => {
  it('refuses a feature without the recycle bin', async () => {
    await expect(
      runner.runSchematic(
        'feature',
        {
          name: 'invoices',
          fields: 'title:string',
          addons: 'merge',
          softDelete: false,
          skipImport: true,
        },
        empty(),
      ),
    ).rejects.toThrow('recycle bin');
  });
});
