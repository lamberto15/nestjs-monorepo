# modules/choices

Dependent dropdowns: pick a unit, then one of its members. The choices come from providers declared by trusted code, never from a URL or query a request names.

- **Provider:** an injectable marked `@ChoiceSource()` implementing `ChoiceProvider`: a `key`, typed `params`, `mayUse()`, `options()` and `has()`. What it returns is already what the caller may see.
- **Set:** fields that choose together, each naming a provider and which sibling field fills each parameter. Declared with `ChoicesModule.forFeature({ sets })`; checked at startup (unknown provider, parameters, cycles, more than 4 levels fail the boot). The module ships `organizational-units`, `unit-members` and the set `unit-member`.
- **Routes** (`/v1/choices`, anyone signed in): `GET`, `GET /{set}`, `GET /{set}/{field}/options?parent.<field>=…&q=&limit=`, `POST /{set}/validate`.
- **On a record:** `ChoicesModule.forRecord(DECLARATION, SET)` (the set's fields are the record's field names) refuses a create, and an update that touches a set field, unless every value is a choice the writer could pick for its parents' values, those stored with the record included (400, one error per field). The system principal is not held to it.
- **Elsewhere:** inject `ChoicesService` and call `assertValid(principal, set, values)`.

Remove: delete this folder and its line in `app.module.ts`.
