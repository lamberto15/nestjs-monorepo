# modules/documents

A record's PDF: filled from a template with the fields the requester may
read, rendered by [Gotenberg](https://gotenberg.dev) on a worker (queue
`documents`), stored on the private disk (modules/storage). Off without
`GOTENBERG_URL`.

## In a record's module

```ts
imports: [DocumentsModule.forRecord(INVOICE, { template: 'invoice', dir })];
```

Without options the module's own `pdf-record` template lists the record's
fields. `dir` is a `templates/` folder holding `<template>.html` (and
`<template>.<locale>.html`); `pdf-layout` wraps it. Handlebars syntax
(@nestjs/mail's engine), every `{{ value }}` escaped; nothing remote (inline
CSS, `data:` images). The context has `title`, `record` (field to text),
`rows` and `labels`.

## Routes

- `POST /v1/<path>/{id}/pdf` (`Idempotency-Key`, `?lang=`): 202 `{ id, status }`.
  Whoever may read the record; 10 a minute per user; 409 `document_pending`;
  503 `documents_unavailable`.
- `GET /v1/<path>/{id}/documents`: the record's documents, newest first, paged.
- `GET /v1/documents/{id}`: state; `GET /v1/documents/{id}/download[?inline=true]`:
  302 to a five-minute signed link. Both need the right to read the record
  and every field the PDF shows (404 otherwise).
- `GET /v1/lists/{subject}`: `capabilities.pdf` and `documentTemplates`.

The issued PDF is also a locked attachment of the record (modules/attachments: `attachmentId` on the document, in the `document.ready` event and in the record's attachments; nobody removes it, 409 `attachment_locked`). The layout shows the tenant's brand (name, colour, logo: `BrandingService.forDocument()`), and the record's documents list gives `issuedByName` (modules/people). Realtime: `document.ready`, `document.failed`. Audited: `document.requested`,
`document.issued`, `document.failed`. A render claims the document with a
token and its own file key, so a job run twice issues one PDF. Transient
failures are retried (`DOCUMENTS_RENDER_ATTEMPTS`); a refused page or an
inactive requester fails at once. A record deleted for good takes its
documents with it, and their files once the purge commits (modules/storage's
`StoredFiles`). A person's documents are in their data export (`documents`) and stay
with their records, asked for by nobody, when their account is deleted.
`GET /v1/features` reports `documents` (whether GOTENBERG_URL is set).

## Variables (`documents.config.ts`)

GOTENBERG_URL, GOTENBERG_TIMEOUT_MS (30000), DOCUMENTS_RENDER_ATTEMPTS (3).

## Gotenberg

Its own container, reachable by the workers only: never Chromium in the
worker. In development:

```bash
docker compose -f compose.dev.yaml --profile documents up -d --wait
# then GOTENBERG_URL=http://127.0.0.1:3100 in apps/api/.env
```

A deployment starts it the same way (`compose.dev.yaml` has the flags):
`--chromium-allow-list=^file:///tmp/`, `--chromium-deny-private-ips`,
`--chromium-deny-public-ips` and `--chromium-disable-javascript` (the page
loads nothing but itself and runs no script), `--api-disable-download-from`,
`--webhook-disable`, and an `--api-timeout` longer than
`GOTENBERG_TIMEOUT_MS`. No published port, and a network with no way out.

Add-on: `pnpm feature:add --addons documents` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `documents.addon.js`): a record's PDF, from templates/<item>.html.

Remove: `pnpm module:remove documents` ([removing-a-module](../../../../../docs/removing-a-module.md)).
