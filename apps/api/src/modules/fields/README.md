# modules/fields

A record's fields, declared once: each field knows its column, its API
schemas and its list filter, and the table, schemas, list, mapping and
samples for tests are derived from the declaration.

```ts
const FIELDS = {
  title: field.string().searchable(),
  total: field.money(),
  dueOn: field.date().optional(),
  status: field.enum(['draft', 'sent', 'paid']).default('draft'),
  code: field.string().unique(),
  customerId: field.ref(() => customers).optional(),
};
export const invoices = tenantTable(
  'invoices',
  { id: uuidPk(), ...fieldColumns(FIELDS), ...timestamps() },
  (t) => fieldExtras('invoices', t, FIELDS),
);
```

- **Types** (`field.ts`): `string`, `text`, `int`, `decimal` (a string end to
  end), `money` (two columns, `{ amount, currency }` in the API), `bool`,
  `date`, `datetime`, `enum`, `json`, `ref`. Modifiers: `optional()` (null),
  `default(v)`, `unique()` (per tenant), `searchable()`, `readOnly()` (set by the
  service, never by a body), `onDelete()` (a reference's rule). Text fields are
  bounded under the request body limit (`core/http/body-limit.ts`).
- **Derived** (`fields.ts`): `fieldColumns`, `fieldExtras` (unique indexes, a
  reference's index and tenant-scoped key), `fieldSchemas` (create, update,
  response), `fieldValues` (body to column values), `fieldView` (row to API
  view), `fieldSnapshot`, `fieldSamples` (for tests), `writableFields`,
  `searchableFields`.
- **List** (`fields.list.ts`): `fieldList` gives the `listQuery` entries
  (filters and sorts by type; a money field filters by currency).
- `tableHolds(table, subject)` tells a `ref` field what its target holds; the
  record module calls it for the tables it makes.

Imports `core/tenancy` (`tenantReference`), `core/http/body-limit` and
`modules/money`. No Nest, no variables, no routes: drizzle-kit loads it
through the tables.

## Remove

`pnpm module:remove fields` ([removing-a-module](../../../../../docs/removing-a-module.md)).
