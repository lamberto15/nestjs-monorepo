# metrics

Prometheus metrics (prom-client) at `GET /metrics`: HTTP request durations by route pattern (`http_request_duration_seconds`), requests in flight, calls to `@Deprecated()` routes, the database pool and its use (`db_pool_connections`, `db_connection_acquire_duration_seconds`, `db_query_duration_seconds` by operation, `db_failures_total`, `db_last_failure_timestamp_seconds` and `db_incidents_total`: `database_busy` no connection in time, `database_timeout` a cancelled statement, `slow_query` over 1 s; when the database module is there), refused telemetry uploads (`telemetry_rejected_total`) and Node's defaults.

- **Variable:** `METRICS_TOKEN` (16 characters or more). Unset, `/metrics` answers 404; set, it needs `Authorization: Bearer <token>`. Scrape it from inside the private network.
- **Your own metrics**, in your own module's folder: inject `MetricsService` (the module is global). A counter or histogram: `new Counter({ name, help, registers: [metrics.registry] })`. A value read at scrape time (queue depth, lag): `metrics.collect(name, help, () => [{ value }])`; a read that fails or takes over 2 s leaves the gauge out of that scrape.
- **Remove:** delete this folder and its line in `app.module.ts`.
