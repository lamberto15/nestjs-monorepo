# modules/shares

Read-only links to one record: a member who may share it makes a link that shows chosen fields to whoever holds it, or only to one address that proves its mailbox with a mailed code, until it expires or is revoked.

- **Opt in:** a feature imports `SharesModule.forRecord(DECLARATION)`: routes `GET|POST /v1/<path>/{id}/shares` and `DELETE …/shares/{shareId}`, the `share` action on its subject, `capabilities.shares`, and its links go when the record is purged. Editors may share their own records; add `actions.share` texts to the feature's `permissions.<subject>` catalog.
- **Public routes** (`/v1/shared`, no sign-in, throttled per address): `POST /open` and `POST /code`, the token in the body (the web app reads it from the link's fragment, `WEB_URL/shared#<token>`). Every refusal is the same 404 `share_not_found`.
- **Safety:** the token (256 random bits) is shown once, only its hash is kept. Opening checks the link, its tenant, its maker (still an active member) and the record, and shows the fields as the maker may read them now: never more than the maker sees, never a reference field. Only a person (not a client, not while impersonating) makes one; at most 20 working links per record. Audit: `share.created|revoked|opened`.
- **Variables:** `WEB_URL` (else `APP_URL`), `SERVICE_NAME`, `SHARE_MAX_DAYS` (30).
- **Tables:** `record_shares`. Mail: `share-code` (needs MailModule's queue).

- **Files:** `files: true` in the create body (and `files` in every link's answer) lists the record's uploaded files in what a link shows (`files: [{ id, name, size, contentType }]`, scanned, oldest first) when its feature also imports `AttachmentsModule.forRecord()`; `POST /v1/shared/files/{attachmentId}` (the token in the body, like `open`) answers `{ url }`, a signed download link valid 5 minutes, audited `share.opened` with the file. An issued document (locked attachment) is never shared: it may show fields the link leaves out.

Remove: delete this folder and the `forRecord()` imports.
