// `--fields "title:string,amount:money?,status:enum(draft|sent),code:string!unique"`:
// the field types of modules/fields (field.ts), `?` optional, `!unique`
// unique per tenant.

const CAMEL = /^[a-z][a-zA-Z0-9]*$/;

/** The columns every record has (modules/records, record.ts), and the add-ons' keys. */
const RESERVED = new Set([
  'id',
  'tenantId',
  'ownerId',
  'unitId',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'deletedBy',
  'search',
  'can',
  'custom',
  'tags',
  'number',
  'namingSeriesId',
]);

export const TYPES = [
  'string',
  'text',
  'int',
  'decimal',
  'money',
  'bool',
  'date',
  'datetime',
  'enum',
  'json',
  'ref',
];

/** One field from `name:type`, `name:type?`, `name:type!unique`, `name:enum(a|b)`, `nameId:ref(other-feature)?`. */
export function parseField(spec) {
  const match = /^([^:]+):([a-z]+)(?:\(([^)]*)\))?(\?)?(!unique)?$/.exec(
    spec.trim(),
  );
  if (!match) {
    throw new Error(
      `--fields "${spec}": write name:type, ? for optional, !unique for unique (title:string, dueOn:date?, code:string!unique).`,
    );
  }
  const [, name, type, arg, optional, unique] = match;
  if (!CAMEL.test(name))
    throw new Error(`--fields: "${name}" is a camelCase name (dueOn).`);
  if (RESERVED.has(name))
    throw new Error(
      `--fields: "${name}" is a name every record (or an add-on) has already.`,
    );
  if (!TYPES.includes(type))
    throw new Error(
      `--fields: "${type}" is not a type; one of ${TYPES.join(', ')}.`,
    );
  const field = { name, type, optional: !!optional, unique: !!unique };
  if (type === 'enum') {
    const values = (arg ?? '').split('|').filter(Boolean);
    if (
      values.length < 2 ||
      !values.every((v) => /^[a-z][a-z0-9-]*$/.test(v))
    ) {
      throw new Error(
        `--fields: "${name}:enum(…)" lists two values or more, lowercase: enum(draft|sent|paid).`,
      );
    }
    field.values = values;
  } else if (type === 'ref') {
    if (!arg || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(arg)) {
      throw new Error(
        `--fields: "${name}:ref(…)" names a feature: ref(customers).`,
      );
    }
    if (!name.endsWith('Id'))
      throw new Error(
        `--fields: a reference's name ends with Id: ${name}Id:ref(${arg}).`,
      );
    // The generated test can't make the other feature's record.
    if (!optional)
      throw new Error(
        `--fields: "${name}:ref(${arg})" is optional (${name}:ref(${arg})?); make it required by hand once both exist.`,
      );
    field.ref = arg;
  } else if (arg !== undefined) {
    throw new Error(`--fields: "${type}" takes no (…).`);
  }
  if (unique && !['string', 'int'].includes(type))
    throw new Error('--fields: !unique applies to string and int fields.');
  if (unique && optional)
    throw new Error(`--fields: "${name}" can't be both optional and unique.`);
  return field;
}

/** Every field of `--fields`, at least one, names unique. */
export function parseFields(list) {
  const fields = String(list ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .filter(Boolean)
    .map(parseField);
  if (fields.length === 0)
    throw new Error(
      '--fields: give at least one field (--fields "title:string").',
    );
  const seen = new Set();
  for (const f of fields) {
    if (seen.has(f.name))
      throw new Error(`--fields: "${f.name}" is given twice.`);
    seen.add(f.name);
  }
  return fields;
}

/** The field a record is called by (duplicates, computed default, titles): its first required string. */
export const titleField = (fields) =>
  fields.find((f) => f.type === 'string' && !f.optional) ?? null;
