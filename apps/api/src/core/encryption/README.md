# core/encryption

Personal data the database should never hold in clear (tax numbers, national ids, bank details) goes in an **encrypted column**: AES-256-GCM with the deployment's keys, bound to its table, column and tenant, with an optional **blind index** (HMAC-SHA-256) to find rows by value. `EncryptionModule` is global.

- **Declare** in the module that owns the table: `taxNumber: encryptedText('tax_number')` (and `taxNumberIndex: blindIndexText('tax_number_index')` to look up by value), then `encrypted(table.taxNumber, { blindIndex, normalize: normalizers.exact })` at module scope (`normalizers`: `exact`, `text`, `email`, `phone`), and list the column on one of the module's providers: `@EncryptedColumns([table.taxNumber])`. The service finds them through discovery: no central list, removing a module removes its columns. The table needs an `id`; both columns are `text`. Keep an encrypted column out of a search vector.
- **Write and read** in the service: `EncryptionService.seal(column, value, tenantId?)` gives `{ taxNumber, taxNumberIndex }` for an insert or update; `lookup(column, value)` is the condition matching the blind index under every configured key; `decrypt(column, stored)` throws a `DecryptionError` (never with the value in it) when a value does not open. A tenant table's values need the tenant: the current scope's, or the `tenantId` argument.
- **Stored form:** `v1.<key id>.<iv>.<ciphertext>.<tag>`. `v1` binds the table, column and tenant: a value copied elsewhere fails to open. The key id is derived from the key, so the environment needs no ids.
- **Rotation:** put the new key first in the list (the first encrypts, all decrypt), then run `ReencryptionService.run(db)` (500 rows at a time, idempotent, a value that does not open is reported, never changed). Remove an old key only when nothing is stale.
- **Boot check:** the app refuses to start when a column is declared and its keys are missing, or when BLIND_INDEX_KEYS shares a key with DATA_ENCRYPTION_KEYS. A key shorter than 32 characters is refused.
- A declared column's property name is also kept out of the logs (core/logging).

Variables (`encryption.config.ts`): DATA_ENCRYPTION_KEYS, BLIND_INDEX_KEYS (comma-separated, newest first; `openssl rand -base64 32` each). Both are empty by default: only an app with no encrypted column can leave them so. Both are secrets: each can be given as `<NAME>_FILE` instead (core/config), and the logger masks them.

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
