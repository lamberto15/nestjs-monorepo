import { ConfigModule, type ConfigType } from '@nestjs/config';
import {
  bullmqTelemetry,
  NestrixModule,
  nestrixInstrumentIf,
} from '@nestrix-js/nestjs';
import { readEnv } from '../config/env.js';
import { logRedaction, type LogRedaction } from '../logging/redaction.js';
import {
  type ObservabilityEnv,
  nestrixEnabled,
  observabilityConfig,
  schema,
} from './observability.config.js';

/**
 * Nestrix (@nestrix-js/nestjs): the self-hosted backend's own NestJS module.
 * On when `OTEL_EXPORTER_OTLP_ENDPOINT` is set and NestJS Observe is not
 * (`nestrixEnabled`): a span for every request (named by its route), for
 * the app's own controllers, services and processors (`nestrixInstrument()`
 * in main.ts and worker.ts), for pg queries, outgoing calls and BullMQ jobs
 * (core/queues), exported over OTLP with runtime metrics. Off, it registers
 * nothing and loads no OpenTelemetry SDK.
 */

/** The `instrument` option of `NestFactory.create()` when Observe's isn't: method spans while Nestrix is on. */
export const nestrixInstrument = (env: ObservabilityEnv = readEnv(schema)) =>
  nestrixInstrumentIf(nestrixEnabled(env));

/**
 * BullMQ's `telemetry` option (core/queues): BullMQ's own spans for adding
 * and running a job, on the OpenTelemetry API (so Observe's provider gets
 * them too), with a failed job marked as an error and its result never
 * recorded.
 */
export const jobTelemetry = () => bullmqTelemetry();

/** `OTEL_EXPORTER_OTLP_HEADERS` (`name=value,name=value`, values percent-encoded), read here because it may come from a secret file. */
export function otlpHeaders(value: string | undefined) {
  const headers: Record<string, string> = {};
  for (const pair of value?.split(',') ?? []) {
    const at = pair.indexOf('=');
    if (at > 0) {
      headers[pair.slice(0, at).trim()] = decodeURIComponent(
        pair.slice(at + 1).trim(),
      );
    }
  }
  return headers;
}

/**
 * The query keys whose values a span must not carry, beyond Nestrix's own
 * list: the log-redaction registry's names (`query.state` is `state`, which
 * the OIDC callbacks carry). Read when the module is built.
 */
export function redactedQueryKeys(redaction: LogRedaction = logRedaction) {
  return [
    ...new Set(
      redaction
        .paths()
        .map((path) => (path.startsWith('query.') ? path.slice(6) : path))
        .filter((name) => !name.includes('.')),
    ),
  ];
}

export const nestrixModule = () =>
  NestrixModule.forRootAsync({
    imports: [ConfigModule.forFeature(observabilityConfig)],
    inject: [observabilityConfig.KEY],
    useFactory: (config: ConfigType<typeof observabilityConfig>) => ({
      // forRootAsync: when off, its providers are inert and the SDK is never loaded.
      enabled: config.nestrix,
      serviceName: config.serviceName,
      serviceVersion: config.release,
      export: {
        otlp: {
          endpoint: config.otlpEndpoint,
          headers: otlpHeaders(config.otlpHeaders),
        },
      },
      // Health probes every few seconds are no trace worth keeping.
      ignore: { paths: ['/health', /^\/health\//] },
      http: { redactQueryKeys: redactedQueryKeys() },
      // The dashboard is the Nestrix server's; this process keeps no copy.
      ui: false,
    }),
  });
