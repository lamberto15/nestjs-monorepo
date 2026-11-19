# Recent records

The records a person opened lately, newest first, for the web app's "recent"
list. Bounded (20, the oldest drops out), nothing older than 30 days, their
own alone. A record add-on (records README, "Writing an add-on").

## Routes

| Route                     | Does                                                                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/recents`         | Yours, newest first, without a record you can no longer read                                                                                   |
| `POST /v1/recents`        | Notes that you opened a record: `{ subject, recordId, label }`; again moves it up; 404 when you cannot read it or its feature has not opted in |
| `DELETE /v1/recents/{id}` | Removes one                                                                                                                                    |
| `DELETE /v1/recents`      | Clears your history                                                                                                                            |

Only a pointer and the title the page showed are stored, never a field. The
view is noted by the web app's `POST`, not by a read of the record: a read
that wrote would change nothing the record shows (the ETag rule), but it
would make every `GET` a write.

## On a record

`RecentsModule.forRecord(RECORD)` in the feature module's imports. It shows
nothing on the record; it lets the subject be noted and removes its entries
when records are deleted for good. `RecentsRetentionJob` deletes old entries
every night at 03:40 UTC, on one instance.

A person's entries are in their account data export and deleted with the
account (`RecentsPersonalData`, section `recents`, iam/personal-data).

Tests: `recents.e2e-spec.ts`, on the fixture's test items.

Add-on: `pnpm feature:add --addons recents` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `recents.addon.js`): the records a person opened lately.
