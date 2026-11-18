// The `merge` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons merge` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import { titleField } from '../../../schematics/feature/kit.js';

export default {
  order: 140,
  about: 'find duplicates and merge them (needs the recycle bin)',
  check: (c) => {
    if (!c.softDelete)
      throw new Error(
        '--addons merge: a merged duplicate goes to the recycle bin; keep --soft-delete.',
      );
    if (!titleField(c.fields))
      throw new Error(
        '--addons merge: the feature needs a required string field to find duplicates by.',
      );
  },
  imports: { MergeModule: 'modules/merge/merge.module.js' },
  call: (c) => `MergeModule.forRecord(${c.R})`,
  test: (c) => `
it('merge: a record lists its likely duplicates', async () => {
  const item = await create();
  const duplicates = await call('GET', \`${c.url}/\${item.id}/duplicates\`, ${c.writer});
  expect(duplicates.statusCode, duplicates.body).toBe(200);
  expect(duplicates.json().items).toBeInstanceOf(Array);
});`,
  routes: ['duplicates', 'merge'],
};
