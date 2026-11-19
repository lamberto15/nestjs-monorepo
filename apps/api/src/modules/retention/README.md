# modules/retention

Personal data is not kept forever. A module that owns such data declares
how its records age; a tenant turns the rule on; a nightly job purges or
anonymises what is old, never what a legal hold (iam/holds) keeps.

## Declaring a rule

In the owning module's imports:

```ts
RetentionModule.forFeature({
  name: 'note', // the route key
  label: 'Notes',
  subject: 'Note', // the permission subject, what a hold names
  table: notes, // a tenant table
  ageColumn: notes.createdAt, // what dates a record
  action: 'purge', // or 'anonymise'
  defaultDays: 730,
  minDays: 30,
});
```

- `purge` deletes the rows, after `RecordPurges.forget()` has asked every
  provider marked `@RecordPurge({ subject? })` to remove what refers to
  them (comments, tags: tables without a foreign key to the record).
- `anonymise` keeps the rows and overwrites what identifies a person:
  `anonymise: { set: { email: null }, pending: isNotNull(t.email) }`.
  `pending` is the condition of a row not yet anonymised, so each row is
  written once.
- `where` limits which rows are ever due (a closed record, say).

A declared rule **does nothing** until a tenant turns it on. Rules are found
at startup (`RetentionRules`); a duplicate name, an anonymising rule without
`anonymise`, or a default below `minDays` fails the start.

### A record's rule

`RetentionModule.forRecord(RECORD, table, { defaultDays, minDays?, label?, ageColumn?, where? })` declares a purging rule named by the record's path, dated by `createdAt` unless `ageColumn` says otherwise. The records module's purge removes what the record's add-ons keep (their `purged` hook) and empties references; never a held record. Retention takes the declaration only structurally (`{ subject, path }`): records already import this module.

## Routes (`Access.manageRetention`)

- `GET /v1/retention/rules`: the rules with the tenant's choice and last run.
- `PUT /v1/retention/rules/{name}` `{ enabled, days? }`: days not below
  `minDays`; audited `retention.policy-changed` (from, to).
- `GET /v1/retention/rules/{name}/preview?days=`: a dry run. How many
  records a run would take now, and how many a legal hold keeps. Changes nothing.

## The job

Never in a request. `RetentionScheduler` runs every night at 04:10 UTC on one
instance and, for every tenant (deactivated ones too) and each enabled rule,
queues a job on the `retention` queue. `RetentionProcessor` handles one batch
of 500 rows in the tenant's scope as `system:retention` and queues the next
while a batch comes back full:

- the batch's SQL leaves out held records (`notHeld()`), and the rows are
  locked (`FOR UPDATE SKIP LOCKED`);
- each batch is one transaction with its audit entry, `retention.purged` or
  `retention.anonymised` (`rule`, `ids`, `retentionDays`), in the tenant's log;
- resumable: a handled row leaves the rule's condition, so a job that dies is
  retried and the next night finds what is left;
- the policy keeps `lastRunAt` and `lastCount`; when a hold keeps due rows
  the first batch logs how many.

A hold placed while a batch's transaction runs applies from the next batch.

## Not covered

Audit entries, revisions, exports and stored files are not reached by rules
yet. The audit log and the revisions have their own
(`AUDIT_RETENTION_DAYS`, `REVISIONS_RETENTION_DAYS`). Recently
opened records and similar per-person history have fixed lifetimes of their
own.

## Tests

`retention.e2e-spec.ts`, `retention.rules.spec.ts`; fixture
`test/fixtures/retention/retention-items.ts`.

Add-on: `pnpm feature:add --addons retention` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `retention.addon.js`): records purged after the days a tenant sets.

Remove: `pnpm module:remove retention` ([removing-a-module](../../../../../docs/removing-a-module.md)).
