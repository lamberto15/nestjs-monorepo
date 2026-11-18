# modules/bulk

Act on many records of one type at once: delete, restore or change. Each
item goes through the record's own store (`RecordStore`), as its routes do:
the policy check, the field-level check, the add-ons' hooks, legal holds, the
record's audit entry and domain event. An item that fails does not stop the
others.

## Turning it on

In the feature module's imports: `BulkModule.forRecord(ITEM)`. The record's
list description then says `capabilities.bulk`. Needs `QueuesModule` and
Redis. `restore` is offered only with a recycle bin.

## Routes

- `POST /v1/<path>/bulk` `{ action, ids | filter, input? }`: `action` is
  `delete`, `restore` or `update`; `ids` are 1 to 500 record ids, `filter`
  the list's own filters (`{ "status": "draft", "title.startsWith": "Old" }`,
  at least one; `limit`, `sort`, `deleted`… are refused); `input` is the PATCH
  body of the record's fields (`update` only). Idempotent as the record's
  create is. Up to `BULK_SYNC_LIMIT` ids (100) answer `200 { done, failed,
skipped, results }`, one result per id in the order sent; more ids, and every
  filter, are a job: `202 { id, status: 'queued' }`.
- `GET /v1/bulk` (`?status=`, `?kind=`, cursor) and `GET /v1/bulk/{id}`: the
  runs you queued in this tenant, with progress (every 100 items), times and
  result (10 000 item results kept; counts exact). Only the principal who
  started a run sees it; kept 7 days.

Errors: `validation_failed`, `bulk_too_many`, `forbidden` (no permission for
the action at all), `field_forbidden` (a filter on a field hidden from you).
A failed item carries the code its own route would answer
(`legal_hold`, `record_referenced`, `field_forbidden`…); an id that is missing
or not yours is `skipped` (`not_found`).

## How it works

`BulkService` checks the action's permission, parses the selection and
input (again in the worker), selects the records the principal may act on in
SQL (`access.sqlFilter()`, keyset by id), and calls the store per record, each
in its own transaction. Jobs run on the `bulk` queue (one attempt, never
retried blindly; a lost worker fails the run, items done stay done). The
principal is checked again when the job starts. Audit: `bulk.started` (the
run's one line in the log, `targetId` the run id), then each record's own
entry and `bulk.finished` (or `bulk.failed`, with its reason, when a
queued run fails for good), all carrying the run id (`runId`, from
`inAuditRun()`); realtime `bulk.progress`, `bulk.finished`, `bulk.failed`.
A watcher of changed records hears once per run (`record.bulk-changed`),
linking to the record list filtered by `?bulkRun=<id>`, which every record
list takes.

Limit: an `update` writes the record's fields through the store, not
through the feature's service, so a field the service derives (a read-only one)
is not recomputed.

Variable: `BULK_SYNC_LIMIT` (bulk.config.ts).

Remove: delete this folder and the `BulkModule.forRecord()` imports.
