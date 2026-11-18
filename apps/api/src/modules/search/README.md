# Search

`GET /v1/search?q=`: one search box over every registered record
(modules/records) that declares `.searchable()` fields, best matches first
across them. `subject=` narrows it to one kind.

- Only records the caller may read (`access.sqlFilter`), never the recycle bin.
- Field-level permissions: a field the caller may read on no record, or on
  some only, is not matched (a vector of the other fields is made at query
  time) and gives no snippet.
- Each hit: `subject`, `id`, `title` (the first string field), a `snippet` with
  the matches in `<b>…</b>`, `score`, `link` (`/<path>/<id>`) and
  `subjectLabel` (from the declaration's noun).
- Other modules add hits with a provider marked `@SearchSource('Subject')`
  (`search.source.ts`) implementing `search(principal, q, { limit })`: merged
  with the records' hits by score, asked only when `?subject=` is absent or
  names its subject. Attachments adds `Attachment` hits (files' text).
- Ranking reads every row it ranks: at most the newest `RANK_CAP` matches are ranked.
