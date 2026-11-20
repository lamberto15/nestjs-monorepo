# modules/sequences

Human-readable numbers (`INV-2026-00042`): gapless per tenant, next to the UUID the API keys by.

- **`SequencesService.next(name, { prefix, perYear, width, scope })`** takes the next number in the caller's current transaction (`@Transactional()` or `TransactionHost.withTransaction()`; outside one it throws). The counter row is locked until commit: no duplicates, and a rollback leaves no gap. A busy series serializes its writes: number only what people quote.
- **Naming series** (Frappe's): administrators define formats per numbered subject, `INV-.YYYY.-.MM.-.#####`, at `/v1/naming-series` (`Access.manageNamingSeries`; reads for anyone signed in). Patterns have date parts, variables (`FY`, `ABBR`: settings `numbering.fiscalYearStart`, `numbering.abbreviation`), the record's fields in braces, and one counter. The counter is keyed by what the pattern prints around it; selection: the body's `namingSeriesId`, then conditions by priority, then the default, then the declared format (which carries on its counter). Counters can be set (never below what is taken), and a pattern previewed.
- **A module that numbers records** imports `SequencesModule.forFeature({ subjects: [{ subject, sequence, declared, fields }], variables })` and, in its create transaction, calls `NamingSeriesService.next(subject, { seriesId, values: body })`. Example: `test/fixtures/sequences/numbered-widgets.ts`.
- **A record's number:** `SequencesModule.forRecord(RECORD, { prefix?, perYear?, width? })` in the feature's imports, with `numberColumns()` in its `recordTable()` and `NUMBER_BODY` / `NUMBER_RESPONSE` in its `recordSchemas()` (sequences.record.ts). The record's `creating` hook takes the number in the create's transaction (no gap on a rollback; the body's `namingSeriesId`, else the tenant's rules, else the declared format, by default the subject's initials, per year, five digits). `?number=` and `?sort=number` on its list. Example: `test/fixtures/sequences`.
- **A record's key from a series:** `SequencesModule.forRecord(RECORD, format, { field: 'reference' })` numbers the record's own field instead (no `number` column), when a create leaves it empty; a value typed in is kept. Its patterns may also print each reference's key and its parents' (`{book}`, `{book_shelf}`: modules/records, "Keys"). Example: `test/fixtures/keyed`.
- **Variable:** `SEQUENCES_TIMEZONE` (the zone of year, month and day in numbers; default UTC).
- **Tables:** `sequences`, `naming_series` (tenant tables).

Add-on: `pnpm feature:add --addons sequences` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `sequences.addon.js`): a human-readable number on each record.

Remove: `pnpm module:remove sequences` ([removing-a-module](../../../../../docs/removing-a-module.md)).
