# modules/people

The directory of a tenant's people and units, for pickers and mentions. Only
a key and a name, never an address or a role.

- `GET /v1/people?q=&limit=`: the active members whose name contains `q`
  (any case; `%` and `_` are themselves), by name; at most 20.
- `GET /v1/people?key=user:<id>,client:<id>`: the names behind principal keys
  records hold (an author, an owner), in the order asked: a member or former
  member of the tenant, or one of its API clients. A key with no name in the
  tenant is left out, so the answer never tells it from one that doesn't
  exist. Not with `q`.
- `GET /v1/organizational-units?q=&id=&limit=&cursor=`: every unit of the tenant
  (id, type, name, parent, depth), newest first in cursor pages. Managing
  units stays on `/v1/access/organizational-units`.

Both routes are `@Can.Anyone()` and users only (an API key is refused).

## Using it

`PeopleService` is exported: `names(keys)` (a map key to name or null, one
query per kind), `named(keys)`, `directory(q, limit)`, `keysOfEmails(emails,
among)` (an address resolves only among keys already known, so it never tells
whether an address belongs to anyone) and `principal(key)` (the active member
or API client behind a key, for checking what a push may show them).

`PeopleService` is also the audit log's and the revisions' `@ActorNameSource()`, and
the comments take their names from it. Each person has `avatarUrl`
(`AvatarsService.urlOf`, modules/attachments/avatars): a path, or null for none
and for an API client. The module imports `StorageModule` and `AvatarsModule`.

## Removing it

Delete the folder and its line in `app.module.ts`.
