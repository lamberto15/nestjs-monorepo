# Lists

`GET /v1/lists/{subject}`: a list described at runtime, from the same
declaration its list route validates with. A generic table builds its filter
menus, sorts, column pickers and views from it.

`GET /v1/lists/{subject}/options`: a record's ids and titles, for a
reference's picker, filter and cells (any record, its title the first string
field after its parent's, as `?include=` gives it: records README, titles). `q` searches the titles (`ilike`), `id=` (20
at most) names the ids a page holds; only live records the caller may read,
and no title for one who may not read the title field everywhere. A subject
that is not a record is a 404.

Any other parameter is a filter of the record's own list, validated and
permission-checked as its list route does it: `?productId=<id>` offers one
product's statuses, for a picker that depends on another field. `sort`,
`cursor`, `page`, `count`, `fields` and `deleted` are refused (400). In the web
app: `<field.RecordField subject="ProductStatus" filter={{ productId }} />`
(an empty value is no filter); clearing the dependent field when its parent
changes is the form's to do.

- Sources: every record registered with `RecordsModule.forFeature()` (its
  list with the add-ons' filters), plus the access API's `User` list and the audit pages' `Audit` and `SignIn` lists (whoever holds `Access.readAudit`).
- Who: whoever may read the subject on some record (`ListPolicy`); for `User`,
  whoever may open the access API; for `Audit` and `SignIn`, whoever holds
  `Access.readAudit`. An unknown subject is a 404 before any
  permission check.
- Field-level permissions: a field the caller may read on no record is left
  out; one they may read on some records only has no operators and is not
  sortable (and `search` is false when `q` reads one).
- `capabilities`: a map from each add-on's `capability` to its `available()`.
  Add-ons' `describe()` keys are merged at the top level. `views` come from the
  record's declaration (checked at startup), `related` lists the records
  whose `ref` field points at this subject (`record-relations.ts`) that the
  caller may read and filter by that field. `recycleBin` is true with
  `softDelete` for whoever may `restore` the subject.
