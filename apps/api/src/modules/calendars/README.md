# modules/calendars

Business calendars: the hours a tenant works each weekday on the wall clock
of a time zone, and the dates that differ (holidays, special hours). Routes
under `/v1/calendars` (anyone signed in reads and computes deadlines;
`Access.manageCalendars`, users only, writes; audited as
`businessCalendar.created|updated|deleted`).

- `POST /v1/calendars/{id}/deadline`: `minutes` of working time after `from`
  (0: the first working moment at or after it), daylight-saving changes
  followed, with the calendar's `version` to store beside the deadline. A
  calendar with no working time answers 400 `calendar_has_no_working_time`.
- `version` rises when the hours, zone or exceptions change, not on a rename;
  deadlines already computed are never touched.
- Other modules call `CalendarsService.row(id)` and `addWorkingMinutes()`;
  `calendar-time.ts` is the pure math (`wallClock`, `zonedMoment`).
- A calendar a recurring schedule follows can't be deleted (409): the
  schedule's foreign key restricts.

No variables. Remove: delete this folder and its line in `app.module.ts`
(and modules/recurrence, which follows calendars).
