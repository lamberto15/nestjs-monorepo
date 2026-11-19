# Favorites

A person pins the records and pages they open often; the web app lists them
in the sidebar, in their order. Their own alone, no audit. A record add-on
(records README, "Writing an add-on").

## Routes

| Route                       | Does                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/favorites`         | Yours, in your order, without a record you can no longer read                                                                                                                             |
| `POST /v1/favorites`        | Pins one last: `{ kind: 'record', subject: 'Note', target: <id>, label }`, `{ kind: 'page', target: '/notes', label }` or `{ kind: 'view', subject: '/notes', target: <view id>, label }` |
| `PUT /v1/favorites/order`   | `{ ids }`: every favorite once, in the new order                                                                                                                                          |
| `DELETE /v1/favorites/{id}` | Unpins one                                                                                                                                                                                |

At most 50 per person and tenant; pinning the same thing twice is a 409
`favorite_exists`. A record is pinned only if the caller can read it (a
404 otherwise) and only if its feature imports `FavoritesModule.forRecord(RECORD)`.

## On a record

`FavoritesModule.forRecord(RECORD)` in the feature module's imports. It adds
`?include=favorite` (the caller's favorite id for the record, null when it is
not one; outside the ETag) and removes the favorites of records deleted for
good. The record's table and bodies are not touched.

A `view` (a saved view, modules/views) is pinned only if the caller sees it
(`ViewsService.get`, a 404 otherwise), and leaves the list when they stop
seeing it or it is deleted; `subject` is the list page it opens on.

A person's favorites are in their account data export (`favorites`) and
deleted with their account.

Tests: `favorites.e2e-spec.ts`, on the fixture's test items.

Add-on: `pnpm feature:add --addons favorites` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `favorites.addon.js`): people pin records they open often.
