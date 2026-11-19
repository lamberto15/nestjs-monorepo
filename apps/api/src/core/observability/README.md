# observability

Production telemetry. Off until a backend's variables are set, and it costs nothing while off. There are two backends, swapped by configuration alone:

- **NestJS Observe** (hosted; `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`): traces, runtime metrics, errors and logs of requests and jobs (`observe.ts`). `main.ts` and `worker.ts` pass `observeInstrument()` to Nest.
- **Nestrix** (self-hosted, over OpenTelemetry; `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`): [`@nestrix-js/nestjs`](https://github.com/nestrix-js/nestrix) (`nestrix.ts`) traces every request by route, the app's own controllers, services and processors (`nestrixInstrument()` in `main.ts` and `worker.ts`), pg queries, outgoing calls and BullMQ jobs (`jobTelemetry()`, core/queues), with runtime metrics, over OTLP/HTTP. The backend meant for it is the Nestrix server, which takes OTLP on port 4318; any OpenTelemetry collector works too. With Observe on as well, Observe exports to that endpoint and Nestrix stays off, so nothing is recorded twice. Redis commands get no spans: Nestrix's ioredis integration is opt-in, because it turns an unawaited failing command's crash into silence.

In development, `pnpm traces:up` runs the Nestrix server on http://localhost:4318 ([development](../../../../../docs/development.md#traces)).

`instrument.ts` loads `.env` before Nest builds the app, so both `instrument` choices read it. Nestrix reads the endpoint and the credential (or its `_FILE` secret) itself, and keeps `code`, `state` and other secrets out of span URLs. Gaps found in Nestrix are fixed there (https://github.com/nestrix-js/nestrix/issues/49 tracks them), not worked around here.

What the app's own code uses is backend-neutral (the OpenTelemetry API), so it works with either:

- **`reportError()`**: the problem-details filter reports the 5xx errors it answers; call it for an error you handled but that should be seen. It lands on the active span.
- **`traceCorrelation()`**: the active trace id on log lines.
- **Refused uploads:** a backend that turns telemetry away (401, 403, 429) leaves the app blind and running. It is counted in `telemetry_rejected_total{target,status}` (`core/metrics`): Observe's through its log lines, Nestrix's through its `export.onFailure`.
- **Also read:** `SERVICE_NAME`, `GIT_SHA` (the release), `NODE_ENV`.
- **Remove:** delete this folder and its line in `app.module.ts`, the import of `instrument.ts` in `main.ts`, `worker.ts` and `cli.ts` and the `instrument` option in `main.ts` and `worker.ts`, and `jobTelemetry()` in `core/queues`.
