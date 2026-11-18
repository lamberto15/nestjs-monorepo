# modules/custom-fields

Fields a tenant's administrators add to a record at runtime, without a
migration. They behave like the record's own fields: checked on every
write, shown with the record, audited key by key, and filtered, sorted and
picked in its list (`custom.<key>`).

## On a record

```ts
// <item>.schemas.ts
recordSchemas(INVOICE, { body: CUSTOM_FIELDS_BODY, response: CUSTOM_FIELDS_RESPONSE });
// <item>s.module.ts
imports: [CustomFieldsModule.forRecord(INVOICE)],
```

- **Bodies** take `custom: { key: value }`, checked against the tenant's
  active fields in the write's transaction: an unknown or inactive key, a
  wrong type, a value that is no option is a 400 `validation_failed` naming
  `custom.<key>`. On create, required fields need a value unless they have
  a default; defaults fill what is left out. On update only the keys sent
  change; `null` removes one (not a required one's). Changes are audited
  as `<item>.customValuesUpdated`, `{ changes: { key: { from, to } } }`.
- **Responses** carry `custom`: the values of active fields (`{}` without
  any). A deactivated field's values stay stored, hidden until it is
  reactivated.
- **GET /v1/lists/{subject}**: `capabilities.custom`, and `customFields`
  (each active field: `name` `custom.<key>`, label, type, options,
  required, filterable, sortable).
- **Purge**: a record gone for good takes its values with it.
- **Lists**: `CustomFieldsExtension.listFields(principal)` gives the
  `custom.<key>` list fields to `list.extend()` for the request: filters
  on fields marked `filterable` (text types: the text operators; number and
  date: the ordered ones; select: `eq`/`in`/`notIn`; multiSelect: `in`,
  holds any of; all `isNull`), sorts on `sortable` ones, `fields=` on all.
  `eq`, `in` and `isNull` use the GIN index; the rest read each row's value.
  The records engine asks for them on each list query and list description
  (`RecordHooks.listFields`), so the record's own list route takes them.

## Values

| Type                                                                          | Stored as              | Validation                          |
| ----------------------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| `text` (1,000), `longText` (10,000), `email` (254), `url` (2,048, http/https) | string                 | `minLength`, `maxLength`, `pattern` |
| `number`                                                                      | JSON number            | `min`, `max`                        |
| `boolean`                                                                     | `true` / `false`       |                                     |
| `date`                                                                        | `YYYY-MM-DD`           |                                     |
| `select`                                                                      | an option's value      |                                     |
| `multiSelect`                                                                 | distinct option values | `min`, `max` (how many)             |

`pattern` runs on RE2 (`custom-field.pattern.ts`): linear time on any
value; lookaround, backreferences and counts above 1,000 are refused when
the field is saved.

## Routes

```
GET    /v1/custom-fields/subjects                 the records that take them, those whose fields you may read
GET    /v1/custom-fields?subject=TestItem[&includeInactive=true][&include=counts]
POST   /v1/custom-fields                          { subject, key, label, type, options?, required?, default?, validation?, position?, filterable?, sortable? }
PATCH  /v1/custom-fields/{id}                     label, description, type, options, required, default, validation, filterable, sortable, active
PUT    /v1/custom-fields/order                    { subject, ids }: these first, the others after
DELETE /v1/custom-fields/{id}                     deactivates: values kept
```

Reading takes `read` on the subject (or managing them); changing,
`Access.manageCustomFields` (users only, never while impersonating);
`include=counts` too. Keys are slugs, never reused. A type change is a 409
`custom_field_in_use` while records hold values, except text → longText
and email/url → text or longText; so is removing a choice records hold. At
most 100 active fields per subject (409 `custom_field_limit`). Audited:
`customField.created|updated|reordered`.

## Exports and imports

The tenant's active fields are `custom.<key>` columns of the record's exports, and of its imports (templates, mappings) when the record also takes `DataTransferModule.forRecord()`: `CustomFieldsTransfer` (`@TransferColumns()`, modules/data-transfer).

## Shared definitions

`customFieldDefinitionSchema` (custom-fields.schemas.ts), `valueSchema`,
`customValuesSchema` and `definitionIssues` (custom-field.values.ts) are
what anything else built from the same definitions (dynamic forms) uses.

## Tables

`custom_field_definitions` and `custom_field_values` (one row per record
holding values, JSONB with a GIN index), both tenant tables. Values live
here rather than in a column of each record's table, so a record takes
custom fields with one import and no migration of its own.

## Remove

Delete this folder and the `forRecord()` imports of the features using it.
