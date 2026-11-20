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
  // A `!numbered` field (`reference:string!numbered`): the series fills that
  // field when a create leaves it empty, instead of a number column.
  call: (c) => {
    const f = numberedField(c);
    return f
      ? `SequencesModule.forRecord(${c.R}, undefined, { field: '${f.name}' })`
      : `SequencesModule.forRecord(${c.R})`;
  },
  body: ['NUMBER_BODY'],
  response: (c) => (numberedField(c) ? [] : ['NUMBER_RESPONSE']),
  columns: (c) =>
    numberedField(c)
      ? {}
      : { numberColumns: 'modules/sequences/sequences.record.js' },
  test: (c) => {
    const f = numberedField(c);
    return f
      ? `
it('sequences: a new record left without its ${f.name} takes a number', async () => {
  const item = await create({ ${f.name}: undefined });
  expect(item.${f.name}).toMatch(/\\d{5}$/);
});`
      : `
it('sequences: a new record has its number', async () => {
  const item = await create();
  expect(item.number).toMatch(/\\d{5}$/);
});`;
  },
};

/** The feature's `!numbered` field, if it has one. */
const numberedField = (c) => c.fields.find((f) => f.numbered);
