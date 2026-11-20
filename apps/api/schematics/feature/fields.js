// `--fields "title:string,amount:money?,status:enum(draft|sent),code:string!unique"`:
// the field types of modules/fields (field.ts), `?` optional, `!unique`
// unique per tenant, `!unique(productId)` unique within another field, `!numbered` a string a naming series fills when a create
// leaves it empty (optional and unique; the sequences add-on). `markdown` is a `text` field to the API; the web pages
// edit it with the Markdown editor and show it rendered.

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
  'markdown',
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

/** One field from `name:type`, `name:type?`, `name:type!unique`, `name:type!unique(otherId)`, `name:string!numbered`, `name:enum(a|b)`, `nameId:ref(other-feature)?`. */
export function parseField(spec) {
  const match =
    /^([^:]+):([a-z]+)(?:\(([^)]*)\))?(\?)?(?:!(unique|numbered)(?:\(([^)]*)\))?)?$/.exec(
      spec.trim(),
    );
  if (!match) {
    throw new Error(
      `--fields "${spec}": write name:type, ? for optional, !unique for unique, !unique(productId) for unique within another field, !numbered for a number from a naming series (title:string, dueOn:date?, code:string!unique, reference:string!numbered).`,
    );
  }
  const [, name, type, arg, optional, flag, within] = match;
  if (within !== undefined && flag !== 'unique')
    throw new Error(`--fields: "${spec}": only !unique takes (…).`);
  const unique = flag === 'unique';
  if (flag === 'numbered') {
    if (type !== 'string' || optional)
      throw new Error(
        `--fields: "${name}:${type}${optional ?? ''}!numbered": !numbered applies to a string field, which it makes optional and unique (${name}:string!numbered).`,
      );
    // Left empty, a naming series fills it; a value typed in is kept.
    return { name, type, optional: true, unique: true, numbered: true };
  }
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
  if (within !== undefined) field.within = within;
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
  if (type === 'markdown') {
    field.type = 'text';
    field.markdown = true;
  }
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
  if (fields.filter((f) => f.numbered).length > 1)
    throw new Error('--fields: one field at most is !numbered.');
  for (const f of fields) {
    if (f.within !== undefined && !fields.some((o) => o !== f && o.name === f.within))
      throw new Error(
        `--fields: "${f.name}" is unique within "${f.within}", which is no other field of it.`,
      );
  }
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
