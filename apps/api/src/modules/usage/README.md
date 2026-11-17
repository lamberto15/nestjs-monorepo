# modules/usage

What each API client calls, per UTC day and route, and an optional daily
request quota per client. Nothing for a route to declare: every request
authenticated with an API key is metered (users, guests, `/health` and `/api`
are not, nor requests refused before the handler).

- **Counting** (`UsageInterceptor`, global): once the response is done (or
  the caller hung up) it `HINCRBY`s the Redis hash
  `tenant:<tenantId>:usage:<clientId>:<yyyy-mm-dd>` (field `<METHOD> <route pattern>`
  and `_total`; 3 days TTL). Redis down or slower than 500 ms: requests go through, uncounted, logged.
- **Quota**: `PUT /v1/access/clients/{id}/daily-quota { dailyQuota }` (`Usage.setClientQuota`;
  null removes it; audited as `client.quota-changed`), stored in `api_client_quotas`. A client with one
  gets `X-Quota-Limit` and `X-Quota-Remaining`; past it, 429 `quota_exceeded` with `X-Quota-Reset` and
  `Retry-After` (seconds to midnight UTC). Exact: a request takes its place on entry, atomically, so parallel
  requests never pass it; a refused one is given back. A change applies on the client's next request.
- **Roll-up** (`UsageRollupJob`, 00:20 UTC, one instance): copies days before today into `api_usage`,
  tenant by tenant, deletes those counters and rows older than USAGE_RETENTION_DAYS. Reports merge rows and
  live counters, so today is always included.
- **Routes**: `GET /v1/access/clients/{id}/usage?from=&to=` (`Usage.read`), `GET /v1/usage` (the calling
  client's own; a user gets 403). Answer `{ from, to, days: [{ day, total, routes }], total, dailyQuota }`;
  default the last 30 days, at most 400.
- **Order**: list `UsageModule` in `app.module.ts` after `SharedIdempotencyModule` (a replay is not
  counted, and is answered past the quota) and before `SharedHttpClientModule`.

Variables (`usage.config.ts`): USAGE (`off`: no metering, no routes, no roll-up, quotas stored but not
enforced), USAGE_RETENTION_DAYS. Tenant limits are `modules/quotas`.

Remove: delete this folder and its line in `app.module.ts`.
