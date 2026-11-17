# Lists

`GET /v1/lists/{subject}`: a list described at runtime, from the same
declaration its list route validates with. A generic table builds its filter
menus, sorts, column pickers and views from it.

- Sources: every record registered with `RecordsModule.forFeature()` (its
  list with the add-ons' filters), plus the access API's `User` list.
- Who: whoever may read the subject on some record (`ListPolicy`); for `User`,
  whoever may open the access API. An unknown subject is a 404 before any
  permission check.
- Field-level permissions: a field the caller may read on no record is left
  out; one they may read on some records only has no operators and is not
  sortable (and `search` is false when `q` reads one).
- `capabilities`: a map from each add-on's `capability` to its `available()`.
  Add-ons' `describe()` keys are merged at the top level. `views` come from the
  record's declaration (checked at startup), `related` is empty until
  record relations are ported.
