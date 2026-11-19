# modules/tenant-move

Moving one tenant from a shared server to a server of its own, which runs
the same app (usually `TENANCY=single`; row-level security and `tenant_id`
stay). No routes: the operator CLI drives it (`tenant:freeze <tenant>`,
`tenant:export <tenant> --out <dir>`, `tenant:import <archive> [--key-file]`,
`tenant:moved <tenant> [--erase-accounts]`, `tenant:thaw <tenant>`,
`account:erase <email>`;
[src/cli](../../cli/README.md)). The walk-through for an operator is
[docs/moving-a-tenant.md](../../../../../docs/moving-a-tenant.md).

## What moves

- **The tenant's rows:** every table declared with `tenantTable()` or
  `globalTable()` (`tenantTables()`, core/tenancy: no list kept here), each
  row of this tenant, with its id. That takes its memberships, roles, API
  clients and keys (their hashes), SSO connections and domain routes, audit
  log, settings, quotas and every feature's records.
- **Its accounts:** every account a row of it points at (a key to `users`:
  its members, and anyone else a row names), with its password hash, and the
  rows of the global tables declared with `movesWithAccount()` next to them
  (iam/auth/account-rows.ts): passkeys, the authenticator and its recovery
  codes, identities, password history, consents, phone number, notification
  preferences, picture… The guard test `account-rows.spec.ts` fails on a
  table pointing at `users` that is neither declared nor listed there as
  staying (sessions and refresh tokens, sign-in links, device push tokens:
  people sign in again on the new server). Memberships of other tenants do
  not move.
- **Shared accounts** (also members of another tenant on the source) are
  copied: from then on the two copies are independent. The export lists
  them, and so does the import.
- **Files:** everything under `tenants/<id>/`, and the files under
  `accounts/<id>/` that a copied row names (the picture; not old data
  exports), through the app's disk (`StorageDisk`: local or S3, both ways),
  streamed.

What does not move: what runs outside the tables (queued jobs, outbox
messages, running workflows, Redis), and anything of other tenants.

## The archive

A directory: `manifest.json`, `rows/<n>-<table>.ndjson` (one JSON object per
row) and `files/<n>`. Every file is encrypted on its own (`move-archive.ts`):
AES-256-GCM in 64 KiB chunks (the STREAM construction), its key derived with
HKDF-SHA-256 from the archive key and the file's random salt, each chunk
authenticating the file's path, its index and whether it is the last, so a
file altered, cut short, reordered or swapped fails to open. node:crypto
only; no archive format or package (a tar would need one).

The archive key is 32 random bytes made by the export and printed once
(`tmk1.…`); nothing writes it to disk. The import asks for it, or reads it
from `--key-file`. Why a key and not a key pair or a passphrase: the
operator copies one line between two terminals, there is no key file to keep
on the target, and a random key needs no slow derivation to resist guessing.

Encrypted columns (core/encryption) are opened with the source's keys and
held in clear inside the encrypted archive; the import seals them with the
target's `DATA_ENCRYPTION_KEYS` and computes their blind indexes with its
`BLIND_INDEX_KEYS` (the same tenant id, so the same binding). Blind indexes
are not in the archive.

The manifest (encrypted too) holds the source's schema (core/database
`schemaVersion()`: the last migration and a digest of all), each table's
row count, size and SHA-256, each file's key, size, SHA-256 and type, the
accounts and the tenants each also belongs to on the source.

## The freeze

A tenant's `frozen_at` (core/tenancy) makes every transaction of that tenant
`READ ONLY` from its next one on, decided by the database as the
transaction begins: every request, job and worker of every instance. Writes
answer 503 `tenant_read_only`; reads go on. A sign-in into the tenant writes
its audit entry, so it is refused too: people signed in keep reading. The
export refuses a tenant that is not frozen; the command freezes it first
(asked). `tenant:thaw` undoes it.

## The steps

- `export(actor, tenantId, dir)`: a frozen tenant only, into a new or empty
  directory. Audited `tenant.exported` in no tenant (the frozen tenant's own
  log takes no entry; its `tenant.frozen` entry is in the archive).
- `inspect(dir, key)`: the manifest and what keeps it out: another schema, a
  tenant with that id or slug, with `TENANCY=single` any other tenant, an
  address that already has an account here, a row it points at that is
  missing here (a quota plan), a table or encrypted column this server
  lacks.
- `import(actor, dir, key)`: the rows in one transaction, in the order of
  their keys (rows pointing at each other, parents first); then the files,
  each read back and checked; then every table's count. Audited
  `tenant.imported` in no tenant. Run again it inserts nothing: a tenant
  already here is checked against the archive, missing or different files
  are copied again, and a tenant that changed since is refused.
- `finish(system, tenantId, details, { eraseAccounts })`: on the source,
  only for a frozen tenant: `TenantsService.purge()` with reason `moved`
  (the rows by the cascade, the files released and deleted by the worker).
  It returns the members left in no tenant. Accounts stay unless
  `eraseAccounts`: then each of those is deleted through
  `AccountDeletionJob.deleteNow()` (iam/personal-data: the same deletion as
  a person's own, sections, files and legal holds included). An account in
  another tenant is never deleted. `eraseAccount(system, email)` does it
  later (`account:erase`), for an account in no tenant only.

With `TENANCY=single`, `Tenancy.restore()` makes the moved tenant the one;
the CLI never makes a first tenant or administrator (`FIRST_START_SEED=off`),
and the app's first start makes none once a tenant exists.

## Tests

`move-archive.spec.ts` (keys, the chunked encryption, tampering, the
manifest), `move-rows.spec.ts` (types, order, parents), `account-rows.spec.ts`
(the guard), `tenant-move.e2e-spec.ts` (a source, a fresh single-tenant
target and a multi-tenant one: frozen writes refused, counts, sign-in with
the same password, an encrypted column under the target's keys, files and
checksums, a shared account, another schema refused, a second run, the
erase, accounts deleted only when asked and never one in another tenant).

## Remove

`pnpm module:remove tenant-move` ([removing-a-module](../../../../../docs/removing-a-module.md)). It refuses while `src/cli/tenant-move.commands.ts` uses it: delete that file and its line in `src/cli/cli.module.ts` first.
