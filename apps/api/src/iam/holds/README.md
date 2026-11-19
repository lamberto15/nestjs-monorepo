# iam/holds

Legal holds: records kept whatever a delete, a retention rule or the
recycle bin's purge would do. A hold names a permission **subject** (`Note`,
or `User` for a person) and one **record**, or no record to hold every
record of the subject in the tenant (also the ones made later). It stays
active until released; released holds stay in the list as the record of who
held what and why. `legal_holds` is a tenant table.

| Route (`Access.manageLegalHolds`)                       |                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `POST /v1/legal-holds` `{ subject, recordId?, reason }` | place; audited `legal-hold.placed`                                                      |
| `GET /v1/legal-holds`                                   | list; `?active=true`, `?subject=`, `?recordId=`                                         |
| `GET /v1/legal-holds/{id}`                              | one                                                                                     |
| `POST /v1/legal-holds/{id}/release` `{ note? }`         | release; audited `legal-hold.released`; 409 `legal_hold_released` when released already |

## What a hold forbids

- **A delete:** the module that deletes a record injects `LegalHoldsService`
  and calls `await holds.assertNotHeld('Note', [id])` in the delete's
  transaction (a 409 `legal_hold`).
- **A purge or a rewrite for good:** a job puts `notHeld('Note', table.id)`
  (`holds.tables.ts`) in its SQL, so a held row is never selected. The
  retention job (modules/retention) and the recycle bin's purge
  (modules/records) do.
- **An account deletion:** a hold with subject `User` and the person's id.
  The deletion job (iam/personal-data) asks `heldAmong('User', [id])` and
  keeps the account while one is active.

Deleting a whole tenant ignores holds: the tenant is the unit the owner
removes.

## Tests

`holds.e2e-spec.ts`, `holds.schemas.spec.ts`.

Remove: `pnpm module:remove holds` ([removing-a-module](../../../../../docs/removing-a-module.md)).
