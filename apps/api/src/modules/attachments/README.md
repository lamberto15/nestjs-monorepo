# modules/attachments

Files on a record, and users' pictures ([avatars](avatars/)). An add-on of
[modules/records](../records/README.md): `AttachmentsModule.forRecord(NOTE)`
in the feature module's imports. `AttachmentsModule` itself (the
`/v1/attachments/{id}` routes, the queues, the retry job, the storage quota)
is one however many records take files.

| Route                                                                      | Does                                                                                                              |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /v1/<path>/{id}/attachments` (multipart, field `file`)               | 201; whoever may `update` the record                                                                              |
| `GET /v1/<path>/{id}/attachments`                                          | newest first, cursor pages; `?contentType=`, `?name.contains=`, `?scanStatus=`; whoever may read the record       |
| `GET /v1/attachments/{id}`                                                 | one attachment (404 unless its record is readable)                                                                |
| `GET /v1/attachments/{id}/download`                                        | 302 to a signed link (5 minutes); `?inline=true` shows a PDF; `?rendition=thumb\|preview` an image's smaller copy |
| `DELETE /v1/attachments/{id}`                                              | 204; the uploader, or whoever may `update` the record; the files go too (every version's)                         |
| `GET /v1/attachments/{id}`                                                 | also sends an `ETag`: the `If-Match` of a replacement or restoration                                              |
| `POST /v1/<path>/{id}/attachments/{attachmentId}/versions`                 | 201; replaces the file (multipart `file`, optional `note`, `If-Match`); the old one stays as a version            |
| `GET /v1/attachments/{id}/versions`                                        | the current file first, then the earlier ones, newest first                                                       |
| `GET /v1/attachments/{id}/versions/{version}/download`                     | 302 to a signed link, always a download; `{version}` is the number (404 `attachment_version_not_found`)           |
| `POST /v1/attachments/{id}/versions/{version}/restore`                     | 201; an earlier file becomes current as a new version (optional `note`, `If-Match`)                               |
| `POST /v1/<path>/{id}/attachments/presign`                                 | 201 `{ uploadId, url, method, headers, expiresAt }`: a signed PUT to the bucket; STORAGE_DRIVER=s3 only, else 503 |
| `POST /v1/<path>/{id}/attachments/complete`                                | 201, the attachment, once the file was PUT (presign) or all chunks sent (session) and checked                     |
| `POST\|GET\|PUT\|DELETE /v1/<path>/{id}/attachments/sessions[/{uploadId}]` | a resumable upload in 8 MiB chunks, on every driver; `PUT …?offset=` takes the raw bytes                          |

- **Uploads** stream onto the private disk (`modules/storage`) under
  `tenants/<id>/attachments/`, after the right to the record is checked; the
  type comes from the bytes (`attachments.types.ts`), never the client: 415
  if not in ATTACHMENT_ALLOWED_TYPES or not what was declared, 413 over
  ATTACHMENT_MAX_MB. Both limits are in `GET /v1/lists/{subject}`
  (`attachmentLimits`). The row and its audit entry (`attachment.added`,
  `.removed`) commit together.
- **Quota** `storageBytes` (modules/quotas): a stock quota on the bytes
  kept, 422 `quota_exceeded`; renditions are not counted.
- **Malware scan** (MALWARE_SCANNER `off`, `clamav`, `memory`): `scanStatus`
  is `pending` until a queue job found it clean (download is 409
  `attachment_scan_pending`); infected files are deleted, audited
  `attachment.rejected` and the uploader notified. A failing scanner never
  means clean: the job is retried, then `AttachmentRetryJob` (every five
  minutes) queues it again. Scanning switched off releases what is pending (`attachments.released`).
- **Images** (IMAGE_PROCESSING): JPEG, PNG, WebP and GIF get a thumbnail and a
  preview (`modules/images`) and an original with metadata is replaced by a
  copy without it; `renditionStatus` `pending`, `ready` or `failed`. Waits for
  the scan. A copy past the storage quota or ATTACHMENT_MAX_MB ends `failed`.
- **Records deleted for good** (the bin's purge, a delete without bin) take
  their attachments with them (`purged`), the rows in the purge's
  transaction and the files once it commits (modules/storage's
  `StoredFiles`: a rollback keeps both); a record in the bin keeps them,
  hidden. A record under a legal hold keeps its files (409).
- **Issued documents**: `AttachmentsService.attachStored()` records a file
  the app wrote, `locked` (409 `attachment_locked` on delete); call
  `changed()` after the commit.
- **Realtime** `record.attachments.changed` (`added`, `removed`, `scanned`,
  `processed`) to the record's watchers who may read it.
- **Versions**: `version` (1, then +1 per change), `revisionNote` and
  `versionedAt` are on the attachment; `attachment_versions` holds the files it
  had. A replacement or restoration goes through everything an upload does
  (type from the bytes, size, quota, scan, renditions) and is audited
  (`attachment.replaced`, `.version-restored`). `If-Match` with the attachment's
  ETag: 412 `precondition_failed` if it changed (two racing replacements: one
  wins). 409 `attachment_busy` while the current file waits for its scan or
  renditions, `attachment_locked` for an issued document,
  `attachment_versions_limit` at 100. Versions count in `storageBytes`. An
  infected replacement is deleted and the previous version is current again.
  A version lives as long as its attachment; a legal hold keeps all of them.
- **Direct uploads** (S3): `presign` answers a PUT URL bound to a key the
  server chose, the size and the `Content-Type` (10 minutes); `complete` copies
  the object to a key of the server's own (the URL stays usable until it
  expires), reads it back (size and type by HEAD, the first 64 KiB for the
  bytes' type) and then takes the path of any upload
  (`AttachmentsService.upload()`: quota, audit, scan, renditions). 413, 415 or
  400 `attachment_upload_mismatch` delete the object; 409
  `attachment_upload_incomplete` keeps the upload; 410 an hour after expiry;
  at most 100 open uploads per uploader (429). The bucket needs a CORS rule
  for the web app's origin (`PUT`, `content-type`).
- **Resumable uploads**: a session (`attachment_uploads`, `resumable`) is
  opened with the checks of `presign`; chunks go through the API at `?offset=`
  (409 `attachment_upload_offset_mismatch` unless it is `received`; a chunk
  counts once stored, under the session's row lock, so a failed one is sent
  again at the same offset and a retried one is harmless), parts live under `<key>.parts/`; `complete` assembles them
  and continues as a direct upload. Cancel deletes the parts; a session lasts
  24 hours. Not an attachment, not listed, not in the quota until completed.
- **Sweep** (`AttachmentSweepJob`, 04:05 UTC): deletes the objects and rows of
  uploads an hour past their expiry, audited `attachments.uploads-swept`. The
  files of records deleted for good go with them (`purged`).
- **Search inside files** (ATTACHMENT_TEXT_SEARCH=on): the text of plain text,
  CSV, PDF and DOCX files is extracted on the `attachment-text` queue in a
  sandboxed thread (no environment, 256 MB heap, ATTACHMENT_TEXT_TIMEOUT_MS,
  ATTACHMENT_TEXT_MAX_MB) and stored in `attachment_texts` with the key of the
  file it came from; `AttachmentTextRetryJob` (every five minutes) queues what
  has no text for its current file. `AttachmentSearch.search(principal, q,
{ limit })` returns `Attachment` hits (the file's name, a snippet, a link to
  the record) for records the caller may read now, clean files only, never an
  issued document. It is a `@SearchSource('Attachment')`: `GET /v1/search`
  merges its hits (`?subject=Attachment` asks for files only). Metric
  `attachment_texts_extracted_total{result}`.
- **Field-level permissions on issued documents**: `attachStored(…, { locked,
fields })` records the record fields the PDF shows (`fields`, null for a
  file). Whoever may not read every one of them on that record gets 404 on the
  attachment (`GET /v1/attachments/{id}`), its download, versions and
  restoration. It stays in the record's list, so a page and `total` are
  always right, but its name (made from the record's fields) is shown to
  them as a neutral one (`attachments.withheldName`: `<noun>.pdf`), and a
  filter or sort by name leaves it out; `fields` is not in any response. Its text is never extracted
  or searched. A share link includes it only when its own fields cover them.
- **`presignedUploads`** in `GET /v1/features` (`@Feature`): true with STORAGE_DRIVER=s3.
- **Personal data** (`attachments`): the rows of the files a person uploaded
  are in their export (not the files); with their account the files stay
  with their records, uploaded by nobody.

Variables (`attachments.config.ts`): ATTACHMENT_MAX_MB, ATTACHMENT_ALLOWED_TYPES,
MALWARE_SCANNER, CLAMAV_HOST, CLAMAV_PORT, CLAMAV_TIMEOUT_MS,
MALWARE_SCAN_ATTEMPTS, IMAGE_PROCESSING, ATTACHMENT_TEXT_SEARCH,
ATTACHMENT_TEXT_MAX_MB, ATTACHMENT_TEXT_TIMEOUT_MS (STORAGE_DRIVER decides
whether signed-URL uploads are offered). Needs QueuesModule, StorageModule,
MetricsModule, ImagesModule's config (IMAGE_*), and the modules it imports.

Add-on: `pnpm feature:add --addons attachments` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `attachments.addon.js`): files on a record, scanned and stored on the private disk.

Remove: `pnpm module:remove attachments` ([removing-a-module](../../../../../docs/removing-a-module.md)).
