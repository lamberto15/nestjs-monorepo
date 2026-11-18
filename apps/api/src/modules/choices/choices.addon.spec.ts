import { empty, runner } from '../../../test/schematic.js';

/** What `--addons choices` asks of a generated feature (choices.addon.js). */
describe('the choices add-on of the feature generator', () => {
  it('refuses a feature without an enum field', async () => {
    await expect(
      runner.runSchematic(
        'feature',
        {
          name: 'invoices',
          fields: 'title:string',
          addons: 'choices',
          skipImport: true,
        },
        empty(),
      ),
    ).rejects.toThrow('enum field');
  });
});
