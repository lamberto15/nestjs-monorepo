// The `sequences` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons sequences` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.

export default {
  order: 210,
  about: 'a human-readable number on each record',
  imports: {
    SequencesModule: 'modules/sequences/sequences.module.js',
    NUMBER_BODY: 'modules/sequences/sequences.record.js',
    NUMBER_RESPONSE: 'modules/sequences/sequences.record.js',
  },
  call: (c) => `SequencesModule.forRecord(${c.R})`,
  body: ['NUMBER_BODY'],
  response: ['NUMBER_RESPONSE'],
  columns: { numberColumns: 'modules/sequences/sequences.record.js' },
  test: () => `
it('sequences: a new record has its number', async () => {
  const item = await create();
  expect(item.number).toMatch(/\\d{5}$/);
});`,
};
