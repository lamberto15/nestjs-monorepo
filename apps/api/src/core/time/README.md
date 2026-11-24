# core/time

A time zone's wall clock, with Intl only (no date library; Node has no
Temporal yet): `wallClock(moment, zone)` gives its date and time there,
`zonedMoment(date, minute, zone)` and `zonedInstant(wallClockAsUtc, zone)`
the moment back, following daylight-saving changes (a repeated time is its
first occurrence, a skipped one the moment after the gap, as Temporal's
"compatible"), and `isTimeZone(zone)`. Calendars, recurrence, reports,
notification digests and file imports and exports read the clock through
it.

Tests: `zoned-time.spec.ts`.
