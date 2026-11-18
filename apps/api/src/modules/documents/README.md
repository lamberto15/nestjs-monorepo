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
documents and files with it.

## Variables (`documents.config.ts`)

GOTENBERG_URL, GOTENBERG_TIMEOUT_MS (30000), DOCUMENTS_RENDER_ATTEMPTS (3).

Remove: delete this folder and its line in `app.module.ts`, and the
`DocumentsModule.forRecord()` imports.
