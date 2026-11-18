// The `revisions` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons revisions` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 40,
  about: 'history of every change, comparable and restorable',
  imports: { RevisionsModule: 'modules/revisions/revisions.module.js' },
  call: (c) => `RevisionsModule.forRecord(${c.R})`,
  test: (c) => `
it('revisions: a new record has its first revision', async () => {
  const item = await create();
  const revisions = await call('GET', \`${c.url}/\${item.id}/revisions\`, ${c.writer});
  expect(revisions.statusCode, revisions.body).toBe(200);
  expect(revisions.json().items).toHaveLength(1);
});`,
  routes: ['revisions'],
};
