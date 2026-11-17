# metrics

Prometheus metrics (prom-client) at `GET /metrics`: HTTP request durations by route pattern (`http_request_duration_seconds`), requests in flight, calls to `@Deprecated()` routes, the database pool (when the database module is there), refused telemetry uploads (`telemetry_rejected_total`) and Node's defaults.

- **Variable:** `METRICS_TOKEN` (16 characters or more). Unset, `/metrics` answers 404; set, it needs `Authorization: Bearer <token>`. Scrape it from inside the private network.
- **Your own metrics**, in your own module's folder: inject `MetricsService` (the module is global). A counter or histogram: `new Counter({ name, help, registers: [metrics.registry] })`. A value read at scrape time (queue depth, lag): `metrics.collect(name, help, () => [{ value }])`; a read that fails or takes over 2 s leaves the gauge out of that scrape.
- **Remove:** delete this folder and its line in `app.module.ts`.
