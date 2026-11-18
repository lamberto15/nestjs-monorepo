# data-transfer

Exports of a record's list to CSV or Excel, and imports from CSV or Excel,
as background jobs on the `data-transfers` queue.

## Taking part

A record is exportable and importable when its feature module imports
`DataTransferModule.forRecord(DECLARATION)`. Its name in the routes is the
record's path (`test-items`). That brings `DataTransferModule` along (the
routes under `/v1/data`, the queue and its processor). Needs QueuesModule,
StorageModule and SharedOutboxModule in the app.

## Exports

`POST /v1/data/exports { name, format, filters, sort, timezone }` answers
202 with the transfer's id. It takes what the record's list route takes, and
the same 400s and 403 `field_forbidden`. The worker walks every page of the
list as the caller (`RecordStore.findPage()` and `RecordPresenter.many()`,
so permissions, field redaction and add-ons apply). It writes the file to the
private disk. `GET /v1/data/transfers/{id}` then gives a signed link that
works for 30 minutes.

The columns are:

- the id and every field. Money is written as `12.50 EUR`. Date-times are
  in the reader's zone, named in the header.
- what the add-ons show (`tags`, `number`);
- the tenant's custom fields, one column each, `custom.<key>` (multiple choices comma-separated);
- the owner and `createdAt`.

A CSV starts with a BOM, and its formula-like text is quoted. An Excel file
has a frozen header and date cells.

## Imports

`POST /v1/data/imports` is multipart, with these fields:

- `name` and `file`;
- `dryRun`;
- `matchOn`: the id or a unique field. A row then updates the record that
  key finds among the caller's readable ones.
- `mapping`: JSON, file header to template column, or null to skip a column.

A file may have `custom.<key>` columns: they are put in the row's `custom` and checked by the record's own write (a bad value is that row's error); a dry run, which writes nothing, checks them the same way (the add-on's `importCheck()`).

The upload streams to the disk under the tenant's prefix. Each row is the
record's create body: it is validated by the field schemas and the field
permissions, then written through `RecordStore.create()` or `update()`, so
hooks, audit and events run. Rows are written in groups of 200, each group
in one transaction. A refused group is retried row by row. Every refused row
lands in an errors CSV (row, field, message). The upload is deleted when the
import ends.

`GET /v1/data/imports/{name}/template` gives a file to fill. The Excel
template has a guide sheet and dropdowns. Saved mappings live under
`/v1/data/imports/{name}/mappings`, at most 50 per import.

## A tenant's export (operators)

`POST /v1/tenants/{id}/export { format?: csv | xlsx }` (`@OperatorOnly()`, `Access.exportTenants`,
a recent sign-in, optional Idempotency-Key) queues an export of every record of
that tenant on the same queue and files: 202 with a transfer id, followed at
`GET /v1/data/transfers/{id}` in the operator's own tenant (30 minute link). One row per
record: `kind` (its table; `tenant`; `member` for the members' accounts), `id`, `data`
(JSON). The tables come from `tenantTables()` (core/tenancy), keyset-paged by primary
key or a unique index, each page read in that tenant's scope and filtered by its
`tenant_id`. Left out: the columns a table declares with `secretColumns()`
(core/database, next to the table: a credential's hash, a secret) and every encrypted
column and blind index. A test fails on a tenant column named like a secret
(`hash`, `token`, `secret`…) that is not declared, unless it is listed there as not one; stored files appear as their rows only. The worker checks the operator
again. Audited: `data.export-started` and `data.exported` in the operator's tenant, and
`tenant.export-requested` in both tenants. It is no export name: `POST /v1/data/exports`
answers 404 for it.

## Import limits

`IMPORT_MAX_BYTES` and `IMPORT_MAX_ROWS` are the deployment's ceilings. The
tenant settings `dataTransfer.importMaxMiB` and `dataTransfer.importMaxRows`
may only lower them. The limits are resolved when the upload arrives and
kept with the job.

## Status

`GET /v1/data/transfers` and `/{id}` show only the caller's own
transfers, in this tenant. A finished transfer is kept for 7 days. When a
transfer ends, `transferFinished` is published (data-transfer.events.ts).
Scheduled reports subscribe to it.

Another module's own columns: a provider marked `@TransferColumns()` (data-transfer.columns.ts) implements `exportColumns`, `importColumns` and `importReader` for the records it applies to. Custom fields do (`custom-fields.transfer.ts`); data-transfer imports none of them.

`TRANSFER_TIMEZONE` is the zone of dates when the caller has none.

## Account export

`AccountExportsModule` (account-exports.*) gives a person a copy of
everything held about them. `POST /v1/account/export { format }` answers 202
with an id; a worker on the `account-exports` queue walks every module's
`@PersonalData()` section (`PersonalDataService.export()`) and writes one row
per record (`kind`, `tenantId`, `id`, `data` as JSON) under
`accounts/<id>/exports/`. `GET /v1/account/exports` lists them and
`GET /v1/account/exports/{id}` gives the link (30 minutes), kept 7 days.
Users only, never while impersonating. Needs QueuesModule, StorageModule and
PersonalDataModule.
