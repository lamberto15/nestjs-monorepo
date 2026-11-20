# data-transfer

Exports of a record's list to CSV or Excel, and imports from CSV or Excel,
as background jobs on the `data-transfers` queue.

## Taking part

A record is exportable and importable when its feature module imports
`DataTransferModule.forRecord(DECLARATION)`. Its name in the routes is the
record's path (`test-items`). That brings `DataTransferModule` along (the
routes under `/v1/data`, the queue and its processor; `GET /v1/data` lists
what the caller may export and import). Needs QueuesModule,
StorageModule and SharedOutboxModule in the app.

## Exports

`POST /v1/data/exports { name, format, filters, sort, timezone }` answers
202 with the transfer's id. It takes what the record's list route takes, and
the same 400s and 403 `field_forbidden`. The worker walks every page of the
list as the caller (`RecordStore.findPage()` and `RecordPresenter.many()`,
so permissions, field redaction and add-ons apply). It writes the file to the
private disk. `GET /v1/data/transfers/{id}` then gives a signed link that
works for 30 minutes (see Status: only while the transfer is kept and the
caller still may read the record).

The columns are:

- the record's key first (its declaration's `key`, else the id;
  modules/records, "Keys"), then every field. Money is written as
  `12.50 EUR`. Date-times are in the reader's zone, named in the header. A
  reference (`parentId`) is a column named for it (`parent`) holding its
  record's key, a path for a key within a parent (`S1/B1`); empty when the
  caller may not read it.
- what the add-ons show (`tags`, `number`);
- the tenant's custom fields, one column each, `custom.<key>` (multiple choices comma-separated);
- the owner and `createdAt`.

A CSV starts with a BOM, and its formula-like text is quoted. An Excel file
has a frozen header and date cells.

## Imports

`POST /v1/data/imports` is multipart, with these fields:

- `name` and `file`;
- `dryRun`;
- `matchOn`: the id, a unique field, or the key. A row then updates the
  record that key finds among the caller's readable ones; a key unique
  within a parent is matched within the row's parent (`code` and `shelf`).

A reference column (`parent`) takes its record's key, as an export writes
it: the row gets that record's id, and a key no readable record has is the
row's error (`No item whose code is "X".`).

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
`GET /v1/data/transfers/{id}` in the operator's own tenant (30 minute link,
only while the operator still holds `Access.exportTenants`). One row per
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
transfers, in this tenant. A finished transfer is kept for 7 days
(`TRANSFER_KEPT_MS`, transfer-retention.ts: the jobs, `expiresAt`, the links
and the files all go by it). When a
transfer ends, `transferFinished` (`data.transfer-finished`) is published
(data-transfer.events.ts). Scheduled reports subscribe to it. Whoever started
it hears `data.progress`, `data.export-ready`, `data.import-finished` or
`data.failed` over realtime. Audited: `data.export-started` or
`data.import-started`, then `data.exported`, `data.imported` or
`data.import-checked` (a dry run); saved mappings `importMapping.created|deleted`.

The links (`url`, `errorsUrl`) are signed in one place, each time a
transfer is read, and only:

- while the caller still holds the right the transfer was started with,
  checked as the start and the worker check it: `Access.exportTenants` for a
  tenant's export (`TenantExport.allowed()`), reading the record for an
  export, importing it for an import's report;
- while it is kept: a link works for 30 minutes (`TRANSFER_LINK_TTL_MS`) and
  never past `expiresAt`.

Otherwise the transfer is still shown, its status and rows, with no link.

`TransferFilesSweep` (transfer-files.sweep.ts, every night at 04:35 UTC on
one instance) deletes the files under every tenant's `tenants/<id>/transfers/`
(exports, import reports, uploads an import never got to) written longer ago
than `TRANSFER_KEPT_MS`, the disk's own listing telling their age. It walks
the tenants, deactivated ones too. Needs SharedLocksModule in the app.

Another module's own columns: a provider marked `@TransferColumns()` (data-transfer.columns.ts) implements `exportColumns`, `importColumns` and `importReader` for the records it applies to. Custom fields do (`custom-fields.transfer.ts`); data-transfer imports none of them.

`TRANSFER_TIMEZONE` is the zone of dates when the caller has none.

## Account export

`AccountExportsModule` (account-exports.*) gives a person a copy of
everything held about them. `POST /v1/account/export { format }` answers 202
with an id; a worker on the `account-exports` queue walks every module's
`@PersonalData()` section (`PersonalDataService.export()`) and writes one row
per record (`kind`, `tenantId`, `id`, `data` as JSON) under
`accounts/<id>/exports/`. `GET /v1/account/exports` lists them and
`GET /v1/account/exports/{id}` gives the link (30 minutes, never past
`expiresAt`), kept 7 days: after that the export is shown with no `url`.
Once the file is written, the worker adds a delayed `expire` job on the same
queue (`delay: TRANSFER_KEPT_MS`, id `<export id>-expiry`) that deletes that
file and nothing else, so the cleanup costs one job per export, never a
listing of the accounts' files. A worker down at the deadline deletes it when
it is back; the job is removed once done and kept with the failed ones
otherwise (retry at `/v1/ops/queues`). If it cannot be queued, the file is
deleted and the export fails: ask again. A new request is a new export with a
file and an expiry of its own. Users only, never while impersonating. Needs
QueuesModule, StorageModule and PersonalDataModule.

Add-on: `pnpm feature:add --addons data-transfer` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `data-transfer.addon.js`): exports to and imports from CSV or Excel.
