# iam/personal-data

What the app holds about a person, and their rights over it: a copy of
their data, their account's deletion, and what they agreed to.

## Routes

- `GET /v1/account`: a pending deletion and the consents in force.
- `POST /v1/account/deletion { password? }`: schedules the deletion after
  ACCOUNT_DELETION_GRACE_DAYS (14). Wants a recent sign-in and the
  password when the account has one; 5 tries per address and 10 per
  account in 15 minutes. Signs out every other session and token client,
  and mails a cancel link (`AccountDeletionMail`, essential). Asked again
  while pending: the same request.
- `DELETE /v1/account/deletion`: cancels it (404 when none, or once the
  job started on it).
- `POST /v1/account/deletion/cancel { token }` (public): the mail's link
  (WEB_URL/cancel-deletion?token=…). Every refusal is the same 400.
- `GET|POST /v1/account/consents`, `DELETE /v1/account/consents/{kind}`,
  `GET /v1/account/consent-kinds` (public). The kinds are declared in
  `consent-kinds.ts`, their texts in `i18n/en.json`.

Users only, never while impersonating. Audited: `account.deletion-requested`,
`account.deletion-refused`, `account.deletion-cancelled`, `account.deleted`,
`account.consented`, `account.consent-withdrawn` (in no tenant).

## The deletion job

`AccountDeletionJob`, 03:50 UTC, one instance, as `system:account-deletion`.
A legal hold on the person (`User`, iam/holds) in any of their tenants
keeps the request open. Otherwise it claims the request under the
account's row lock, runs every section's `erase` in each tenant, then the
account's own sections, anonymises the account (`Deleted user`, a
`deleted-<id>@anonymized.invalid` address, no password, inactive) and
deletes its memberships (roles and units cascade), then ends its sessions
and token families.

`deleteNow(actor, userId)` carries out an operator's deletion at once
(a moved tenant's accounts left in no tenant, modules/tenant-move): a
request due now, audited, then the same steps. The module exports the job
for it.

## How long erased data lingers

The one place this is stated; the other pages link here. An erase (a
tenant's, `TenantsService.purge()`, iam/tenants; an account's, the job
above) deletes its rows in its transaction, and its files right after the
commit (modules/storage, through the outbox). What it can't reach in that
transaction ages out of the background stores, each by its own setting:

- **Queued jobs** (Redis) of the erased tenant or account find nothing,
  fail or finish, and are dropped with the queue's finished jobs: within 7
  days at most (core/queues `DEFAULT_JOB_OPTIONS`, `removeOnFail`; no queue
  keeps one longer).
- **Outbox dead letters** (events given up on) within
  OUTBOX_DEAD_LETTER_RETENTION_DAYS (core/outbox).
- **Finished workflow instances**, with their journals, within
  WORKFLOWS_RETENTION_DAYS (core/workflows). An erased tenant's unfinished
  approval workflows are deleted after the commit (modules/approvals).

So everything is gone within the longest of these: 14 days with the
defaults. Lengthen one of them and the window grows with it.

## Taking part: `@PersonalData()`

A module that holds something about a person marks one provider:

```ts
@PersonalData({ name: 'favorites', scopes: ['tenant'] })
@Injectable()
export class FavoritesPersonalData implements PersonalDataSection {
  rows({ key }: PersonalDataSubject) {
    /* the person's rows, or batches */
  }
  async erase({ key }: PersonalDataSubject) {
    /* delete or anonymise */
  }
}
```

`scopes`: `tenant` (called once per tenant the person belongs to, in that
tenant) and/or `account` (once, in no tenant: global tables). `erase` runs
in the job's transaction of that scope. Here: `account` (profile,
memberships, sessions), `consents`, `audit` (entries relabelled
`Deleted user`); iam/account adds `sign-in-methods`; modules/storage adds
`account-files` (every file under `accounts/<id>/`, deleted after the
commit).

`PersonalDataService.export(userId, write)` walks every section, for the
module that writes the export file. Remove: delete this folder, its line
in app.module.ts, and the sections' decorators.
