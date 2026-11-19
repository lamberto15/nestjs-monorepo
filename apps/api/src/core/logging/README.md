# core/logging

The logger, the request log and the redaction of secrets.

- **Logger:** `createLogger()` (`logging.ts`) builds Nest's `ConsoleLogger` before the app and `main.ts` installs it with `app.useLogger()`. One JSON object per line (LOG_FORMAT `json`, the default in production) or readable text. Lines carry the active trace id when core/observability is on.
- **Request log:** `LoggingModule` gives each request an `X-Request-Id` (the proxy's or client's when safe, else a new one), returns it, and logs one line when the request ends (method, path, status, duration, ip, request id). `/health` is not logged. 5xx (not 503) is an error, 4xx a warning.
- **Redaction** (`redaction.ts`): nothing secret reaches a line. Keys (headers such as `authorization`, `cookie`, `x-api-key`; fields such as `password`, `token`, `secret`, `body.code`, `query.code`) are masked at any depth of a logged object, an error's `cause` included; text rules mask `Bearer`/`Basic` credentials, JWTs, `user:password@` in URLs and `name=value` pairs of a secret name inside string messages and stack traces. Variables marked `secret()` in a config are masked too (core/config).
- **A module's own secrets:** `declareSecrets({ headers, fields, patterns })` at module scope, in the module's folder (its `*.config.ts` is natural). `createLogger()` closes the list: a declaration that comes after it throws.

Variables (`logging.config.ts`): LOG_LEVEL (`verbose`, `debug`, `log` default, `warn`, `error`, `fatal`), LOG_FORMAT (`json` or `text`).

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
