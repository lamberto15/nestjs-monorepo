# modules/encryption-admin

Operating core/encryption's keys. The engine (`ReencryptionService`) rewrites
rows under the current keys; this module decides where and when, and shows
where the keys stand.

- **Rotation:** put a new key in front of DATA_ENCRYPTION_KEYS (and
  BLIND_INDEX_KEYS), keep the old ones, deploy. Rows move within the hour;
  when `GET /v1/encryption/status` says `upToDate`, the old keys may leave.
- **Schedule:** every hour at :20, on one instance, it queues one job per
  tenant (deactivated ones too) with stale rows, and one for the tables of no
  tenant, on the `reencryption` queue; the worker runs each in its tenant.
  Idempotent: a row is written only where it still holds the value read.

## Routes (`/v1/encryption`, operators only, `Access.manageEncryption`)

- `GET /status`: the current key ids and, per encrypted column, the rows in
  every tenant still on an older key. It reads each tenant in turn: not for
  polling.
- `POST /reencryption`: queues the jobs now (`{ queued }`). Audited.

Key ids only, never a key.

## Another module

`EncryptionAdminModule` exports `EncryptionAdminService` (`status()`,
`schedule()`, `runNow()`); the CLI's `keys:status` and `keys:reencrypt` use it.
Needs EncryptionModule, QueuesModule and SharedLocksModule.

Remove: `pnpm module:remove encryption-admin` ([removing-a-module](../../../../../docs/removing-a-module.md)). The hourly re-encryption then no longer runs.
