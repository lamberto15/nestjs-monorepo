# modules/computed-fields

Values derived from a record's fields by an expression (modules/expressions),
declared once, computed each time a record is shown, never stored: totals,
durations, derived statuses.

```ts
// <item>.record.ts
export const INVOICE_COMPUTED = defineComputed(INVOICE, {
  total: computed.money('quantity * unitPrice'),
  late: computed.bool('paidOn > dueOn'),
  status: computed.string("if(paidOn == null, 'open', 'paid')"),
});
// <item>.schemas.ts
recordSchemas(INVOICE, { response: computedResponse(INVOICE_COMPUTED) });
// <item>s.module.ts
imports: [ComputedFieldsModule.forRecord(INVOICE, INVOICE_COMPUTED)],
```

- **Kinds**: `int`, `decimal` (a string), `money` (`{ amount, currency }`),
  `string`, `bool`, `date`, `datetime`: each the API type of the field
  kind of that name. An expression reads the record's fields (not JSON
  ones), `createdAt`, `updatedAt` and the other computed fields.
- **Checked when it loads** (`defineComputed`): an expression that doesn't
  compile or isn't the declared kind, a cycle (`a → b → a`), or a name the
  record already shows is an Error naming the field, at startup and in
  every test.
- **Shown** on every read (lists, one record, a write's answer), `fields=`
  may pick them, and they are in the ETag (they depend only on the row).
  Null when a value they read is empty or can't be computed (a division by
  zero, two currencies).
- **Permissions**: a computed field that reads, directly or through another,
  a field the reader may not see on that record is left out too. Naming
  one in the record's permission `fields` restricts it like a stored field.
- **Not** filterable, sortable or searchable: there is no column. Store the
  value in a field the service sets when a list needs it. No clock in the
  language: a value changing with time alone would change the ETag without
  a write.

No routes, tables or variables.

Add-on: `pnpm feature:add --addons computed-fields` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `computed-fields.addon.js`): values derived by an expression on every read.

## Remove

`pnpm module:remove computed-fields` ([removing-a-module](../../../../../docs/removing-a-module.md)).
