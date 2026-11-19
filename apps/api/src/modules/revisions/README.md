# modules/revisions

A record's history: one revision per change, with what changed, readable, comparable and restorable.

- **Turn it on** in the feature's module imports: `RevisionsModule.forRecord(NOTE)`. Nothing else changes in the feature.
- **What is kept**: after each create (revision 1, `changes: null`) and each update, the fields a body may set (`snapshot`, as the API shows them; not read-only fields) and what changed (`changes`, from to). A write that changes nothing adds none. A record written before it kept revisions gets revision 1 from its state before (by `unknown`) on its next change.
- **Routes** under `/v1/<path>/{id}/revisions`:
  - `GET`: newest first, cursor pages; `?changedBy=`, `?number.gte=`, `?createdAt.gte=`.
  - `GET /{number}`: one (404 for a number the record lacks).
  - `GET /{a}/diff/{b}`: from a's values to b's, either order.
  - `POST /{number}/restore`: sets the fields back through the record's own store (the policy's `update`, field-level permissions as a PATCH, `If-Match` 412), audited `<item>.updated`, a new revision with `restoredFrom`. Nothing is written when the record already has those values. Answers the record with its ETag.
- **Who sees what**: whoever may read the record reads its revisions (else 404); fields the reader may not read are left out of snapshots, changes and diffs, and a revision that changed only such fields is not shown at all (not listed nor counted; its GET, a diff with it and its restore are 404): it would tell that, when and by whom a hidden field changed. Its number still leaves a gap.
- **Hooks** (one `@RecordExtension()`): `created`, `updated`, `restored` write revisions; `purged` deletes a record's revisions.
- **Retention**: `REVISIONS_RETENTION_DAYS` (365); every night at 03:25 UTC, one instance, older revisions of every tenant go, each record's latest stays.
- **Table**: `revisions` (tenant table). `changedByName` comes from the audit log's actor names (`@ActorNameSource()`, modules/people), null without that module.

Tests: `revisions.e2e-spec.ts` on the test items.

Add-on: `pnpm feature:add --addons revisions` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `revisions.addon.js`): history of every change, comparable and restorable.
