// The `favorites` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons favorites` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 50,
  about: 'people pin records they open often',
  imports: { FavoritesModule: 'modules/favorites/favorites.module.js' },
  call: (c) => `FavoritesModule.forRecord(${c.R})`,
  test: (c) => `
it('favorites: a record is pinned', async () => {
  const item = await create();
  const pinned = await call('POST', '/v1/favorites', ${c.writer}, { kind: 'record', subject: '${c.t.Singular}', target: item.id, label: 'Pinned' });
  expect(pinned.statusCode, pinned.body).toBe(201);
});`,
};
