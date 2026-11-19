# modules/mode

The deployment's mode, for a risky migration, a restore or an incident:
`platform.mode` (operators set it like any platform value,
`PUT /v1/settings/platform.mode/platform { "value": "read-only" }`; `DELETE` of
the same path returns to `normal`), or `APP_MODE` in the environment, which wins
and makes the setting refuse a new value (use it when the API cannot be reached).

| Mode          | Requests                                                           | Workers and cron |
| ------------- | ------------------------------------------------------------------ | ---------------- |
| `normal`      | Everything works.                                                  | Run.             |
| `read-only`   | GET, HEAD, OPTIONS work; the rest answers 503 `read_only`.         | Paused, skipped  |
| `maintenance` | Everything answers 503 `maintenance`, but `@AllowInMaintenance()`. | Paused, skipped  |

Both refusals are problem documents with `Retry-After: 30`. A route that must
keep working carries `@AllowInMaintenance()` (`core/http/maintenance.ts`):
health, signing in, the operators' routes, `GET /v1/features` (it carries `mode`).
A route whose calls are decided one by one carries `@ReadOnlyPerCall()`
(`mode.guard.ts`): in read-only mode the request passes and each MCP tool call
runs only when its tool declares `readOnlyHint: true` (modules/mcp).
Where workers run (`APP_ROLE` worker or all) a restricted mode pauses this
process's queue workers (running jobs finish) and stops the `@Cron` jobs; `normal`
resumes both. Metric `app_mode{mode}`. Not covered: WebSocket messages and running jobs.

Locked out of ending it? `DELETE /v1/settings/platform.mode/platform` as an operator
(a token minted for the operators' tenant), or remove `APP_MODE` and restart.

| Variable   | Default | Meaning                                        |
| ---------- | ------- | ---------------------------------------------- |
| `APP_MODE` | unset   | Forces `normal`, `read-only` or `maintenance`. |

Remove: `pnpm module:remove mode` ([removing-a-module](../../../../../docs/removing-a-module.md)).
