// A feature's name in every form the generated files use: plural and
// kebab-case (`invoice-lines`) for the module, table, service and
// controller, singular for what is about one record.

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** `invoice-lines` → `invoice-line`; null when it doesn't look plural. */
export function singularize(plural) {
  if (/(ss|us|is)$/.test(plural)) return null; // address, status, analysis: give --singular
  if (/[^aeiou]ies$/.test(plural)) return plural.replace(/ies$/, 'y');
  if (/(ches|shes|xes|zes|sses)$/.test(plural))
    return plural.replace(/es$/, '');
  if (plural.endsWith('s')) return plural.slice(0, -1);
  return null;
}

const capital = (word) => word[0].toUpperCase() + word.slice(1);
const camel = (kebab) =>
  kebab
    .split('-')
    .map((word, i) => (i === 0 ? word : capital(word)))
    .join('');
const pascal = (kebab) => kebab.split('-').map(capital).join('');

/** Names the template's own routes and modules already take. */
const RESERVED = new Set([
  'access',
  'account',
  'ai',
  'api',
  'approvals',
  'attachments',
  'auth',
  'bulk',
  'choices',
  'comments',
  'custom-fields',
  'data',
  'data-quality',
  'documents',
  'favorites',
  'features',
  'health',
  'lists',
  'notifications',
  'recents',
  'record-schedules',
  'retention',
  'search',
  'settings',
  'shared',
  'subscriptions',
  'tags',
  'templates',
  'tenants',
  'webhooks',
]);

/** Every form of a feature's name; throws with what to do when it isn't plural kebab-case. */
export function names(plural, singularOverride) {
  if (typeof plural !== 'string' || !KEBAB.test(plural)) {
    throw new Error(
      `"${plural}": a feature's name is plural, lowercase words joined by "-" (invoices, invoice-lines).`,
    );
  }
  if (RESERVED.has(plural)) {
    throw new Error(
      `"${plural}" is taken by the template's own routes; choose another name.`,
    );
  }
  const singular = singularOverride || singularize(plural);
  if (!singular || singular === plural) {
    throw new Error(
      `"${plural}": its singular can't be derived; give it with --singular.`,
    );
  }
  if (!KEBAB.test(singular)) {
    throw new Error(`--singular "${singular}": lowercase words joined by "-".`);
  }
  const words = singular.split('-').join(' ');
  return {
    plural, // invoice-lines: the folder, the plural files, the URL path
    singular, // invoice-line: the single-record files
    pluralCamel: camel(plural), // invoiceLines: the table's constant
    singularCamel: camel(singular), // invoiceLine
    Plural: pascal(plural), // InvoiceLines: module, service, controller
    Singular: pascal(singular), // InvoiceLine: the permission subject
    SINGULAR: singular.split('-').join('_').toUpperCase(), // INVOICE_LINE
    table: plural.split('-').join('_'), // invoice_lines
    nouns: plural.split('-').join(' '), // invoice lines
    noun: words, // invoice line
    aNoun: `${/^[aeiou]/.test(singular) ? 'an' : 'a'} ${words}`,
  };
}

/** `dueOn` → `Due on`: a label. */
export const label = (name) => {
  const spaced = name.replace(/[A-Z]/g, (l) => ` ${l.toLowerCase()}`);
  return spaced[0].toUpperCase() + spaced.slice(1);
};
/** `InvoiceLine` → `invoice-line`: where a subject's texts are (iam/access, permission-catalog.ts). */
export const kebabOf = (subject) =>
  subject.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
