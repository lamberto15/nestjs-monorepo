import { ConfigModule, type ConfigType } from '@nestjs/config';
import {
  bullmqTelemetry,
  NestrixModule,
  nestrixInstrumentIf,
} from '@nestrix-js/nestjs';
import { readEnv } from '../config/env.js';
import {
  type ObservabilityEnv,
  nestrixEnabled,
  observabilityConfig,
  schema,
} from './observability.config.js';
import { recordTelemetryFailure } from './telemetry-health.js';

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

/**
 * Nestrix reads the endpoint and the collector's credential itself
 * (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` or its
 * `_FILE` secret) and keeps `code`, `state` and other secrets out of the
 * spans' URLs.
 */
export const nestrixModule = () =>
  NestrixModule.forRootAsync({
    imports: [ConfigModule.forFeature(observabilityConfig)],
    inject: [observabilityConfig.KEY],
    useFactory: (config: ConfigType<typeof observabilityConfig>) => ({
      // forRootAsync: when off, its providers are inert and the SDK is never loaded.
      enabled: config.nestrix,
      serviceName: config.serviceName,
      serviceVersion: config.release,
      // A collector that refuses the data (401, 403, 429) is counted in
      // telemetry_rejected_total (core/metrics), so an alert sees it.
      export: {
        onFailure: (failure) =>
          recordTelemetryFailure('otlp', failure.httpStatus ?? undefined),
      },
      // Health probes every few seconds are no trace worth keeping.
      ignore: { paths: ['/health', /^\/health\//] },
      // The dashboard is the Nestrix server's; this process keeps no copy.
      ui: false,
    }),
  });
