# modules/client-errors

`POST /v1/client-errors`: the web app reports an error it did not expect
(`reportClientError`, `apps/web/src/lib/report-error.ts`: React's error
callbacks, the window's uncaught errors, a route's error page). The report
is logged at `error` with its id, source, route and message, the stack on
its own line; redaction applies as to every server-side log line. Nothing
is stored beyond the log.

- **Public** (`@Public()`): an error can happen before sign-in, and the
  answer says nothing about an account either way.
- **Limit**: 120 a minute per address, under the web app's own 20 a minute
  per tab. The global limit still applies.
- **Body**: the field limits in `client-errors.schemas.ts` (a few lines, not
  a dump). Answers 204 when logged, 400 `validation_failed` otherwise.

## Remove

Delete this folder and its line in `app.module.ts`. The web app's reports
then fail silently (its `fetch` ignores a failure); nothing else depends on
this module.
