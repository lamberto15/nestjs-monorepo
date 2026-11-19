# Moving a tenant to its own server

A customer that wants a server of its own (a "dedicated" deployment) runs
the same app there, usually with `TENANCY=single`. Row-level security and
every `tenant_id` stay, so its tenant moves as it is: same ids, same rows.
The move is three commands of the operator CLI, never a copy by hand. What
moves and how the archive is protected:
[modules/tenant-move](../apps/api/src/modules/tenant-move/README.md).

## Before

- The **same release** on both servers, migrated (`node dist/migrate`). The
  import refuses an archive of another schema.
- The **target** is a fresh database: migrated, with the app **not yet
  started** on it (a first start makes a tenant and an administrator; the CLI
  never does). On a multi-tenant target, the tenant's id and slug, and its
  people's addresses, must not be there yet.
- The target's own `DATA_ENCRYPTION_KEYS` and `BLIND_INDEX_KEYS` (new keys:
  `keys:generate`), its disk (local or S3) and its `.env`. Platform rows the
  tenant points at (a quota plan) must exist on the target.
- The source's **worker drained** for that tenant
  (`backlog:count --tenant <slug>`): queued jobs and outbox messages
  do not move.

## The steps

On the source (in the image: `node dist/cli …`):

```bash
pnpm ops tenant:export acme --out /backups/acme-move
```

It freezes the tenant first (asked): from then on every write of it is
refused (503 `tenant_read_only`), by every instance and worker, while its
people keep reading; signing in to it is refused too. It writes the
encrypted archive and prints its **key once** (`tmk1.…`), and lists the
accounts that also belong to other tenants here: they are copied, and the
two copies are independent from then on. Keep the key apart from the archive.

Copy the directory to the new server. There, before the app's first start:

```bash
node dist/cli tenant:import /backups/acme-move          # asks for the key
node dist/cli tenant:import /backups/acme-move --key-file key.txt
```

It refuses with a list when something is in the way (nothing is written
then), otherwise inserts every row in one transaction, writes the files,
reads each back against its checksum, and checks every table's count. The
encrypted columns are sealed with this server's keys. It says `verified` at
the end; run it again after any failure: it inserts nothing twice and copies
only the files that are missing. Then start the app. People sign in with the
passwords, two-factor and passkeys they had; their sessions did not move.

Back on the source, once the target said verified:

```bash
pnpm ops tenant:moved acme                    # the tenant goes; its accounts stay
pnpm ops tenant:moved acme --erase-accounts   # and its accounts left in no tenant are deleted
```

It erases the tenant from the source through the tenants' deletion (its rows,
and its files once the worker runs). It lists the accounts that belonged to
this tenant only. Without `--erase-accounts` they stay, in no tenant;
`pnpm ops account:erase <email>` deletes one later. With it, each is deleted
as its own account deletion would (iam/personal-data: its data, its
`accounts/<id>/` files, anonymised; a legal hold keeps one). An account that
still belongs to another tenant is never deleted.

## Limits

- **Signing in is refused while the tenant is frozen.** A sign-in writes its
  audit entry in the tenant, and every write is refused. People already
  signed in keep reading; some reads that record something answer 503 too.
- **A second tenant whose account is already on the target is refused.** A
  shared account copied by an earlier move is there already with the same
  address; the import refuses rather than merge two copies.
- **Drain jobs, the outbox and workflows first.** Queued jobs, outbox
  messages, running workflows and Redis state do not move: check
  `backlog:count --tenant <slug>` and let the worker finish before
  exporting.

## Aborting

Until `tenant:moved`, the source is untouched but frozen:
`pnpm ops tenant:thaw acme` makes it writable again. An archive written
before is then out of date: export again for a new attempt. A failed import
leaves no rows on the target; files it already wrote under
`tenants/<id>/` stay until the next run overwrites them.
