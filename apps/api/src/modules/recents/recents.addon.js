// The `recents` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons recents` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 60,
  about: 'the records a person opened lately',
  imports: { RecentsModule: 'modules/recents/recents.module.js' },
  call: (c) => `RecentsModule.forRecord(${c.R})`,
  test: (c) => `
it('recents: an opened record is noted', async () => {
  const item = await create();
  const noted = await call('POST', '/v1/recents', ${c.writer}, { subject: '${c.t.Singular}', recordId: item.id, label: 'Opened' });
  expect(noted.statusCode, noted.body).toBeLessThan(300);
});`,
};
