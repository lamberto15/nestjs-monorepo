# iam/audit

The audit log: who did what, in which tenant. `audit_log` is a tenant table
with rows of no tenant (`nullRows: 'outside'`): account-level entries
(sign-in, failed sign-in) are written outside every tenant, a tenant's in its
scope, and row-level security keeps each side to its own.

## In a module

```ts
constructor(private readonly audit: AuditService) {}
await this.audit.record(user, { action: 'note.deleted', targetType: 'note', targetId: id });
```

`record(principal, entry, db?)` in the current scope (pass the
transaction to write with the change); `recordAnonymous(label, entry)`.

## How it is fed

Events from iam/auth (`auth.events.ts`), `@OnEvent` with
`suppressErrors: false`: `auth.signed-in` (account entry, and
`member.signed-in` in the tenant), `auth.sign-in-failed` (account entry,
and `member.sign-in-failed` in each of the account's tenants),
`auth.client-ip-denied` (`client.ip-denied` in the client's tenant).

Discovery decorator: `@ActorNameSource()` on one provider gives display
names for actors (`withActorNames`); none means the stored labels.

## Retention

`AuditRetentionJob`: daily at 03:15 UTC on one instance, deletes entries
older than `AUDIT_RETENTION_DAYS` (400) in every tenant (deactivated ones
too) and outside them, in batches, and records `audit.pruned`. Legal holds
are not here yet.

## Tests

`audit.e2e-spec.ts`; the sign-in entries in iam/auth's e2e.
