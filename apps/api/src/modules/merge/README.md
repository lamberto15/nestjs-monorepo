# modules/merge

Find records that are likely the same, then merge one into the other: the
survivor keeps its id and takes the values you choose from the duplicate, the
records referring to the duplicate point at the survivor, and the duplicate
goes to the recycle bin (restore it to undo; there is no automatic unmerge).

## Turning it on

`MergeModule.forRecord(ITEM, { duplicates: [['email'], ['firstName', 'lastName']] })`
in the feature module's imports. The record needs `softDelete`. A rule is
the fields that must all match (text without case or surrounding spaces,
others exactly; no money or JSON). Left out: the record's first string field
alone. The list description says `capabilities.merge`.

## Routes

| Route                                                          | Does                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /v1/<path>/duplicates` `{ values, excludeId? }`          | the records those values would duplicate (before a create or PATCH) |
| `GET /v1/<path>/{id}/duplicates`                               | a record's likely duplicates                                        |
| `POST /v1/<path>/{id}/merge/preview` `{ duplicateId, fields }` | what the merge would do; changes nothing                            |
| `POST /v1/<path>/{id}/merge`                                   | the merge; answers the survivor                                     |

`{id}` is the survivor; `fields` maps a field to `duplicate` to take its value
(the rest keep the survivor's). Lists are `{ items: [{ id, matched, record }] }`,
newest first, at most 20.

## Checks

Only records you may read, matched only by fields you may read. Merging takes
updating the survivor and deleting the duplicate, choosing only fields you may
read on both and change on the survivor (403 `field_forbidden`), and changing
every record referring to the duplicate, in the bin too (403
`merge_references_forbidden`). A duplicate under a legal hold stays (409
`legal_hold`); a hook refusing the write (an approval pending) refuses the
merge; the survivor cannot end up referring to itself (422 `merge_self_reference`,
`merge_same_record`).

## What happens

In one transaction: the references (the record's `ref` fields, in the bin too)
are repointed; the duplicate is deleted and the survivor updated through the
record's store (their hooks, audit entries, events); each add-on's
`merged({ from, to, by })` hook moves what it keeps about the duplicate
(`store.merged()`); `<item>.merged` is audited with what moved.

## How other add-ons take part

A record's add-on (tags, comments, attachments, watchers, favorites) moves its
rows in the merge's transaction with the `merged({ from, to, by })` hook of
`RecordHooks` (modules/records). A module that is not one of the record's
add-ons listens to the domain event `<item>.merged`
`{ subject, id (survivor), duplicateId, by }`, published in the transaction
(`mergeEvents(record).merged`, core/outbox) and delivered after the commit,
with no import of this module:

```ts
@OnDomainEvent(defineEvent<{ subject: string; id: string; duplicateId: string }>('invoice.merged'), { consumer: 'reports-merge' })
async merged({ id, duplicateId }) { /* update … set recordId = id where recordId = duplicateId */ }
```

The event has its own key, so it is not queued behind the record's other events.

Add-on: `pnpm feature:add --addons merge` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `merge.addon.js`): find duplicates and merge them (needs the recycle bin).

Remove: `pnpm module:remove merge` ([removing-a-module](../../../../../docs/removing-a-module.md)).
