// The `computed-fields` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons computed-fields` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import {
  importLines,
  src,
  titleField,
} from '../../../schematics/feature/kit.js';

/** The record's computed fields (modules/computed-fields). */
function computedFile(c) {
  const title = titleField(c.fields);
  const entry = title
    ? title.name + "Length: computed.int('length(" + title.name + ")')"
    : "edited: computed.bool('updatedAt != createdAt')";
  return (
    importLines([
      ['computed', src(c, 'modules/computed-fields/computed-fields.js')],
      ['defineComputed', src(c, 'modules/computed-fields/computed-fields.js')],
      [c.R, './' + c.t.singular + '.record.js'],
    ]) +
    '\n\n' +
    '/**\n * Values derived from ' +
    c.t.aNoun +
    "'s fields on every read, never stored.\n" +
    ' * Business logic: the computed fields (expressions of modules/expressions).\n */\n' +
    'export const ' +
    c.R +
    '_COMPUTED = defineComputed(' +
    c.R +
    ', {\n' +
    entry +
    ',\n});\n'
  );
}

export default {
  order: 100,
  about: 'values derived by an expression on every read',
  imports: {
    ComputedFieldsModule: 'modules/computed-fields/computed-fields.module.js',
    computedResponse: 'modules/computed-fields/computed-fields.js',
  },
  own: (c) => ({
    [`${c.t.SINGULAR}_COMPUTED`]: `./${c.t.singular}.computed.js`,
  }),
  call: (c) =>
    `ComputedFieldsModule.forRecord(${c.R}, ${c.t.SINGULAR}_COMPUTED)`,
  response: (c) => [`computedResponse(${c.t.SINGULAR}_COMPUTED)`],
  test: (c) => {
    const title = titleField(c.fields);
    return title
      ? `
it('computed fields: shown with the record', async () => {
  const item = await create();
  expect(item.${title.name}Length).toBe(String(item.${title.name}).length);
});`
      : `
it('computed fields: shown with the record', async () => {
  const item = await create();
  expect(item.edited).toBe(false);
});`;
  },
  files: (c) => ({ [c.t.singular + '.computed.ts']: computedFile(c) }),
  readme: (c) => ['- `' + c.t.singular + '.computed.ts`: the computed fields.'],
};
