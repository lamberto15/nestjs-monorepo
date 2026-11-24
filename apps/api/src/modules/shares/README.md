# modules/shares

Read-only links to one record: a member who may share it makes a link that shows chosen fields to whoever holds it, or only to one address that proves its mailbox with a mailed code, until it expires or is revoked.

- **Opt in:** a feature imports `SharesModule.forRecord(DECLARATION)`: routes `GET|POST /v1/<path>/{id}/shares` and `DELETE …/shares/{shareId}`, the `share` action on its subject, `capabilities.shares`, and its links go when the record is purged. Editors may share their own records; add `actions.share` texts to the feature's `permissions.<subject>` catalog.
- **Public routes** (`/v1/shared`, no sign-in, throttled per address): `POST /open` and `POST /code`, the token in the body (the web app reads it from the link's fragment, `WEB_URL/shared#<token>`). Every refusal of the link is the same 404 `share_not_found`; a recipient's link without its right code is a 403 (`share_code_required`, `share_code_invalid`).
- **Safety:** the token (256 random bits) is shown once, only its hash is kept. Opening checks the link, its tenant, its maker (still an active member) and the record, and shows the fields as the maker may read them now: never more than the maker sees, never a reference field. Only a person (not a client, not while impersonating) makes one; at most 20 working links per record (the record's row is locked while they are counted). A recipient's code works 10 minutes and has 5 tries, and a link mails at most 5 codes an hour, from every address together (Redis); the link's row is locked while a code is compared, so tries sent at once take turns. Audit: `share.created|revoked|opened`.
- **Variables:** `WEB_URL` (else `APP_URL`), `SERVICE_NAME`, `SHARE_MAX_DAYS` (30).
- **Tables:** `record_shares`. Mail: `share-code` (needs MailModule's queue).

- **Files:** `files: true` in the create body (and `files` in every link's answer) lists the record's uploaded files in what a link shows (`files: [{ id, name, size, contentType }]`, scanned, oldest first) when its feature also imports `AttachmentsModule.forRecord()`; `POST /v1/shared/files/{attachmentId}` (the token in the body, like `open`) answers `{ url }`, a signed download link valid 5 minutes, audited `share.opened` with the file. An issued document (locked attachment) may show more than the link's fields, so it is listed and downloadable only on a link whose `fields` cover every field it shows, while its maker may still read them all.

Add-on: `pnpm feature:add --addons shares` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `shares.addon.js`): read-only links to one record.

Remove: `pnpm module:remove shares` ([removing-a-module](../../../../../docs/removing-a-module.md)).
