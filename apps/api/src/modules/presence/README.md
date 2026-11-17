# modules/presence

Who is viewing or editing a record now: advisory, never a lock (the record's
ETag still guards saves).

- `PUT /v1/presence/{subject}/{recordId}` `{ mode: 'viewing' | 'editing' }`
  beats (every 15 s; an entry lives 45 s) and answers with the list;
  `GET` lists; `DELETE` leaves. `subject` is the permission subject
  (`Note`).
- State is one Redis hash per tenant and record (principal key to name, mode
  and expiry); only the mode is kept, never what is typed. Redis down: no
  presence, nothing else breaks.
- Whoever may read the record may be on it: the record is found as the caller
  by the provider its module marked `@AccessRecordFinder('Note')`
  (iam/access) and checked with `access.can(…, 'read', …)`; anything else is 404. A subject needs that finder to have presence.
- Arrivals, departures and mode changes push `record.presence`
  `{ subject, recordId }` (ids only) to those on the record, through
  `modules/realtime`; the page fetches the list.

No tables, no variables. Remove: delete this folder and its line in
`app.module.ts`.
