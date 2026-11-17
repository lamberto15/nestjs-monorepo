# observability

Production telemetry. Off until a backend's variables are set, and it costs nothing while off. There are two backends, swapped by configuration alone:

- **NestJS Observe** (hosted; `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`): traces, runtime metrics, errors and logs of requests and jobs (`observe.ts`). `main.ts` and `worker.ts` pass `observeInstrument()` to Nest.
- **Self-hosted, over OpenTelemetry** (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`): traces and metrics over OTLP/HTTP (`telemetry.ts`, started by `instrument.ts`). The backend meant for it is the [Nestrix](https://github.com/nestrix-js/nestrix) server, which takes OTLP on port 4318; any OpenTelemetry collector works too. With Observe on as well, Observe exports to that endpoint and the standalone SDK stays off, so nothing is recorded twice.

What the app's own code uses is backend-neutral (the OpenTelemetry API), so it works with either:

- **`reportError()`**: the problem-details filter reports the 5xx errors it answers; call it for an error you handled but that should be seen. It lands on the active span.
- **`traceCorrelation()`**: the active trace id on log lines.
- **Refused uploads:** a backend that turns telemetry away (401, 403, 429) leaves the app blind and running. It is counted in `telemetry_rejected_total{target,status}` (`core/metrics`).
- **Also read:** `SERVICE_NAME`, `GIT_SHA` (the release), `NODE_ENV`.
- **Remove:** delete this folder and its line in `app.module.ts`, the import of `instrument.ts` and `observeInstrument()` in `main.ts` and `worker.ts`, and the two calls in `core/http` and `core/logging`.
