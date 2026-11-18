# modules/recurrence

Recurring record schedules: a template (one row of a _schedule target_) that
creates a record, as the schedule's owner, at every occurrence of an RRULE
(`FREQ` DAILY|WEEKLY|MONTHLY|YEARLY, `INTERVAL`, `BYDAY`, `BYMONTHDAY`,
`COUNT` or `UNTIL`) at a time of day in a time zone, optionally moved into a
business calendar's working time (modules/calendars). Routes under
`/v1/record-schedules` (each principal sees only their own; preview, pause,
resume, end; at most 20 active per owner).

- **A feature declares what can be scheduled** in its own imports:
  `RecurrenceModule.forFeature({ name, subject, schema, create })`. The owner
  must be allowed `create` on `subject`; `create(principal, row)` runs in the
  occurrence's transaction as the owner and throws to fail the attempt.
- **A record as a target:** `RecurrenceModule.forRecord(RECORD)` in the feature's imports; the target is the record's path, the template one create body, and each occurrence creates the record through its store as the owner (hooks, audit and events as for a request).
- **The runner:** `RecurrenceScheduler` (every 5 minutes, one instance)
  queues one job per tenant that has a schedule due; `RecurrenceProcessor`
  runs it in the tenant as `system:record-schedules` (`runTenant()`). Each
  occurrence is made once however often it is tried (row lock, and a unique
  `record_schedule_runs` row per schedule and moment); a missed one is made up,
  10 per pass; the third failure in a row skips the occurrence; an owner who is
  inactive or lost the permission ends the schedule.

No variables. Remove: delete this folder and its line in `app.module.ts`.
