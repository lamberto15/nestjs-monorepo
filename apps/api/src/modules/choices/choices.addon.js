// The `choices` add-on of the feature generator (apps/api/schematics/feature,
// which finds every src/modules/*/*.addon.js): what `--addons choices` adds to a
// generated feature. Deleting this module takes the add-on out of the generator.
import {
  cap,
  importLines,
  label,
  src,
} from '../../../schematics/feature/kit.js';

/** The choices of its first enum field (modules/choices). */
function choicesFile(c) {
  const f = c.enumField;
  const key = c.t.singular + '-' + c.kebab(f.name);
  return (
    importLines(
      [
        ['Injectable', '@nestjs/common'],
        ['ChoiceProvider', src(c, 'modules/choices/choices.registry.js')],
        ['ChoiceSet', src(c, 'modules/choices/choices.registry.js')],
        ['ChoiceSource', src(c, 'modules/choices/choices.registry.js')],
      ],
      new Set(['ChoiceProvider', 'ChoiceSet']),
    ) +
    '\n\n' +
    '/** The values of `' +
    f.name +
    '` (' +
    c.t.singular +
    '.record.ts). */\n' +
    'const VALUES: readonly string[] = [' +
    f.values.map((v) => "'" + v + "'").join(', ') +
    '];\n\n' +
    '/**\n * The ' +
    label(f.name).toLowerCase() +
    ' a writer may pick: every value of the field.\n' +
    ' * Business logic: narrow them by `principal` or by a parent field (`params`).\n */\n' +
    '@ChoiceSource()\n@Injectable()\nexport class ' +
    c.t.Singular +
    'Choices implements ChoiceProvider {\n' +
    "readonly key = '" +
    key +
    "';\n" +
    "readonly label = '" +
    cap(c.t.noun) +
    ' ' +
    label(f.name).toLowerCase() +
    "';\n" +
    'readonly params = {};\n' +
    'mayUse = () => Promise.resolve(true);\n' +
    'options = () => Promise.resolve(VALUES.map((value) => ({ value, label: value })));\n' +
    'has = ({ value }: { value: string }) => Promise.resolve(VALUES.includes(value));\n}\n\n' +
    '/** The fields chosen together: `ChoicesModule.forRecord(' +
    c.R +
    ', ' +
    c.R +
    '_CHOICES)`. */\n' +
    'export const ' +
    c.R +
    '_CHOICES: ChoiceSet = {\n' +
    "key: '" +
    key +
    "',\nlabel: '" +
    label(f.name) +
    "',\n" +
    'fields: { ' +
    f.name +
    ": { provider: '" +
    key +
    "' } },\n};\n"
  );
}

export default {
  order: 80,
  about: 'a field chosen from a provider (its first enum field)',
  check: (c) => {
    if (!c.enumField)
      throw new Error(
        '--addons choices: the feature needs an enum field to choose from.',
      );
  },
  imports: { ChoicesModule: 'modules/choices/choices.module.js' },
  own: (c) => ({
    [`${c.t.SINGULAR}_CHOICES`]: `./${c.t.singular}.choices.js`,
    [`${c.t.Singular}Choices`]: `./${c.t.singular}.choices.js`,
  }),
  call: (c) => `ChoicesModule.forRecord(${c.R}, ${c.t.SINGULAR}_CHOICES)`,
  providers: (c) => [`${c.t.Singular}Choices`],
  boot: { ChoicesModule: 'modules/choices/choices.module.js' },
  test: (c) => `
it('choices: its ${c.enumField.name} offers its choices', async () => {
  const options = await call('GET', '/v1/choices/${c.t.singular}-${c.kebab(c.enumField.name)}/${c.enumField.name}/options', ${c.writer});
  expect(options.statusCode, options.body).toBe(200);
});`,
  files: (c) => ({ [c.t.singular + '.choices.ts']: choicesFile(c) }),
  readme: (c) => [
    '- `' + c.t.singular + '.choices.ts`: the choices a writer may pick.',
  ],
};
