import { logRedaction, type LogRedaction } from '../logging/redaction.js';
import type { NodeRequest } from '@nestjs/platform-node';
import { matchedRouteKey } from '../http/route-key.js';
import type { ObservabilityEnv } from './observability.config.js';
import { recordTelemetryFailure } from './telemetry-health.js';

/**
 * OpenTelemetry export, off until `OTEL_EXPORTER_OTLP_ENDPOINT` is set:
 * traces and metrics through `@opentelemetry/sdk-node`, exported over
 * OTLP/HTTP to any collector (Grafana Tempo, Jaeger, Honeycomb, Datadog).
 * The SDK reads the standard variables itself (`OTEL_TRACES_SAMPLER`…).
 *
 * **OpenTelemetry and NestJS Observe are not two SDKs side by side.** Both
 * patch http and pg, so together they would record every request and query
 * twice, and Observe's `otlp` export would send every trace a second time.
 * When both are configured, Observe joins: observe.ts turns on its
 * `openTelemetry` and `otlp` options, which export its spans to the same
 * collector from the same variables, and the standalone SDK below is not
 * started (`otelSdkEnabled`).
 *
 * Started by `instrument.ts`, which main.ts awaits before it loads the app:
 * OpenTelemetry patches `http` and `pg` as they load, so it must run before
 * them. The SDK packages are imported only when configured, so an
 * unconfigured app pays nothing.
 */
export const observeConfigured = (env: ObservabilityEnv) =>
  Boolean(env.OBSERVE_APP_KEY && env.OBSERVE_APP_SECRET);

/** Whether the standalone SDK starts: the endpoint is set and Observe is not (it then exports its own spans there). */
export const otelSdkEnabled = (env: ObservabilityEnv) =>
  Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) && !observeConfigured(env);

/**
 * What the exporters hand back for a 429, 502, 503 or 504 once their retries
 * are spent or `Retry-After` outlasts the timeout (otlp-export-delegate.js):
 * those statuses are "retryable", and the result keeps no status or code.
 */
const RETRYABLE_FAILURE = 'Export failed with retryable status';

/**
 * The HTTP status an OTLP exporter's failure stands for: a 401 or 403 is
 * `OTLPExporterError.code`; a 429 has none (see `RETRYABLE_FAILURE`), so the
 * retryable failure counts as the 429 it nearly always is, a rate limit or an
 * exhausted plan.
 */
export const exportFailureStatus = (error: unknown): number | undefined => {
  const { code, message } = (error ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (typeof code === 'number') {
    return code;
  }
  return message === RETRYABLE_FAILURE ? 429 : undefined;
};

/** `ExportResultCode.SUCCESS`; the SDK's enum, spelled out so this file imports nothing from it. */
const EXPORT_SUCCESS = 0;

/**
 * Wraps an exporter's `export()` so a collector that turns the data away
 * (401, 403, 429) is counted (telemetry-health.ts) instead of vanishing in
 * the SDK's diagnostic log. Custom code: the OTLP exporters have no metric
 * of their own for refused exports.
 */
export function countRefusals<
  Items,
  Result extends { code: number; error?: unknown },
  Exporter extends {
    export(items: Items, done: (result: Result) => void): void;
  },
>(
  exporter: Exporter,
  record: typeof recordTelemetryFailure = recordTelemetryFailure,
) {
  const original = exporter.export.bind(exporter);
  exporter.export = (items, done) =>
    original(items, (result) => {
      if (result.code !== EXPORT_SUCCESS) {
        record('otlp', exportFailureStatus(result.error));
      }
      done(result);
    });
  return exporter;
}

/**
 * What the HTTP instrumentation masks in a query string when it is given no
 * list (its README). A list replaces them, so ours starts from them.
 */
const INSTRUMENTATION_QUERY_DEFAULTS = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
];

/**
 * The query parameters whose values a span must not carry: the log-redaction
 * registry's names (`query.code` is `code`; the OIDC callbacks carry `code`
 * and `state`), on top of the instrumentation's own. Spans carry `url.query`
 * (incoming) and `url.full` (outgoing), which the request logger leaves
 * out. Read when the SDK starts, so a name declared later is not in it.
 */
export function redactedQueryParams(redaction: LogRedaction = logRedaction) {
  const names = redaction
    .paths()
    .map((path) => (path.startsWith('query.') ? path.slice(6) : path))
    .filter((name) => !name.includes('.'));
  return [...new Set([...INSTRUMENTATION_QUERY_DEFAULTS, ...names])];
}

/**
 * Runs `build` (which makes the OTLP exporters) with the collector's
 * credential in place: it may come from a secret file, and the exporters
 * read `OTEL_EXPORTER_OTLP_HEADERS` from the environment when they are
 * built, so it is set for that moment only.
 */
function withOtlpHeaders<T>(env: ObservabilityEnv, build: () => T): T {
  const before = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (env.OTEL_EXPORTER_OTLP_HEADERS) {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = env.OTEL_EXPORTER_OTLP_HEADERS;
  }
  try {
    return build();
  } finally {
    if (before === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    } else {
      process.env.OTEL_EXPORTER_OTLP_HEADERS = before;
    }
  }
}

/** Starts OpenTelemetry when the endpoint is set and NestJS Observe is not (`otelSdkEnabled`). */
export async function startOpenTelemetry(env: ObservabilityEnv) {
  if (!otelSdkEnabled(env)) {
    return undefined;
  }
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    { HttpInstrumentation },
    { UndiciInstrumentation },
    { PgInstrumentation },
    { IORedisInstrumentation },
    { RuntimeNodeInstrumentation },
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/exporter-metrics-otlp-http'),
    import('@opentelemetry/sdk-metrics'),
    import('@opentelemetry/instrumentation-http'),
    import('@opentelemetry/instrumentation-undici'),
    import('@opentelemetry/instrumentation-pg'),
    import('@opentelemetry/instrumentation-ioredis'),
    import('@opentelemetry/instrumentation-runtime-node'),
  ]);
  // The service's name and version as resource attributes, through the
  // SDK's own variables (an explicit OTEL_* setting wins).
  process.env.OTEL_SERVICE_NAME ||= env.SERVICE_NAME || 'api';
  if (env.GIT_SHA && !process.env.OTEL_RESOURCE_ATTRIBUTES) {
    process.env.OTEL_RESOURCE_ATTRIBUTES = `service.version=${env.GIT_SHA}`;
  }
  const [traceExporter, metricExporter] = withOtlpHeaders(env, () => [
    new OTLPTraceExporter(),
    new OTLPMetricExporter(),
  ]);
  const redactedParams = redactedQueryParams();
  const sdk = new NodeSDK({
    traceExporter: countRefusals(traceExporter),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: countRefusals(metricExporter),
      }),
    ],
    // Only what this app loads, not the meta-package's ~40 (fs, dns and net
    // are left out on purpose: one span per file read or socket call drowns
    // the trace). Nest's own instrumentation does not support NestJS 12.
    instrumentations: [
      // The server (every request) and node:http clients.
      new HttpInstrumentation({
        // Health probes every few seconds are no trace worth keeping.
        ignoreIncomingRequestHook: (request) =>
          request.url?.startsWith('/health') ?? false,
        // Secrets in a query string (the OIDC callback's code and state)
        // stay out of the spans, as they stay out of the logs.
        redactedQueryParamsServer: redactedParams,
        redactedQueryParams: redactedParams,
        // The route pattern, known once the router matched (core/http):
        // spans group by `GET /v1/notes/{id}`, not by each id.
        applyCustomAttributesOnSpan: (span, request) => {
          // An outgoing call's request (ClientRequest) has no matched route.
          const route =
            'getHeader' in request
              ? undefined
              : matchedRouteKey(request as unknown as NodeRequest);
          if (route) {
            span.setAttribute(
              'http.route',
              route.slice(route.indexOf(' ') + 1),
            );
            span.updateName(route);
          }
        },
      }),
      // fetch and undici (every outgoing call).
      new UndiciInstrumentation(),
      // The database driver Drizzle runs on.
      new PgInstrumentation(),
      // ioredis: BullMQ's queues, the throttler.
      new IORedisInstrumentation(),
      // Event loop, GC and heap metrics, with no native dependency.
      new RuntimeNodeInstrumentation(),
    ],
  });
  sdk.start();
  // Flush what is buffered when the process is asked to stop.
  process.once('SIGTERM', () => void sdk.shutdown().catch(() => undefined));
  return sdk;
}
