# modules/data-quality

Finds what is wrong with records across a tenant: values missing, duplicates, references to deleted records and rules a record breaks. A background scan writes findings; a person fixes the record where it lives, or dismisses the finding as right as it is. Nothing here changes a record.

A record opts in from its feature module's imports:

```ts
DataQualityModule.forRecord(CUSTOMER, {
  recommended: ['email', 'phone'], // empty (null, or blank text): a suggestion
  duplicates: ['name'], // another live record has the same value, whatever its case: a suggestion
  rules: [
    // Written in the expression language (modules/expressions), over the record's fields as the API shows them.
    // A finding when it is false (an empty input makes it null: that is what `recommended` is for).
    {
      name: 'paid-has-date',
      expect: "status != 'paid' or paidOn != null",
      severity: 'error',
      message: 'A paid invoice has a payment date.',
    },
  ],
});
```

Its `ref` fields are always checked: one pointing at a record in the recycle bin is an **error**. A mistake in the declaration (an unknown field, a rule that does not compile or is not a bool) fails the app's start. Add the module to `app.module.ts` once (`DataQualityModule`) when the app has no feature that imports a `forRecord()`.

## Scans

`POST /v1/data-quality/scans` (`DataQuality.scan`) answers 202 and runs on the `data-quality` queue in the tenant that started it: one job per batch of 500 records, each queuing the next, record type after record type (with an id from the scan, the subject and where the batch starts, `onceJob()`: a retried batch queues no second next). `GET /v1/data-quality` shows the `lastScan` (`total`, `scanned`, `status`) and the open findings per subject.

- A finding that still holds is kept (its `checkedAt` moves); one a scan no longer finds is deleted when its subject is done. A dismissed finding stays dismissed while it holds.
- One scan at a time per tenant: another while one runs is a 409 `scan_running`; one over an hour old is taken as lost. A batch that fails its last attempt marks the scan `failed`.
- A scan reads every live record of the tenant (row-level security) as the system; who sees a finding is decided when it is read. Audited `data-quality.scan-started`.

## Findings

- `GET /v1/data-quality/subjects/{subject}/findings`: a subject's open findings (`dismissed=true`, `severity`, `check` filter). `GET /v1/<path>/{id}/data-quality`: one record's, the same page.
- Needs `DataQuality.read`, then the subject's own read permission: only findings on records the caller may read, never on a field their permissions hide or show on some records only (nor a rule that reads one), and a duplicate only when they may also read one of the records it duplicates. `detail.duplicateOf` lists those they may read (up to 50 others are kept per finding, first by id): it names them and tells their value. The summary counts the same way.
- `POST …/findings/{id}/dismiss` (`DataQuality.resolve`): right as it is; audited `data-quality.finding-dismissed`.
- `POST …/findings/{id}/recheck` (`DataQuality.resolve`): checks the record again now; `{ resolved, finding }`.
- Findings of records deleted for good go with them (a `purged` hook).
- Findings no scan or recheck found again for DATA_QUALITY_FINDING_RETENTION_DAYS (180, by `checkedAt`) are deleted every night at 04:55 UTC, on one instance, across tenants (`DataQualityRetentionJob`), dismissed ones too: a scan already deletes what no longer holds, so what is left that old is of a record type no longer scanned, or a scan nobody ran again. The next scan finds what still holds.

No seed role holds `DataQuality.*`: administrators give them in a role.

Tables: `data_quality_findings`, `data_quality_scans` (tenant tables). Variable (`data-quality.config.ts`): DATA_QUALITY_FINDING_RETENTION_DAYS.

Add-on: `pnpm feature:add --addons data-quality` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `data-quality.addon.js`): scans for missing values, duplicates and broken rules.

Remove: `pnpm module:remove data-quality` ([removing-a-module](../../../../../docs/removing-a-module.md)).
