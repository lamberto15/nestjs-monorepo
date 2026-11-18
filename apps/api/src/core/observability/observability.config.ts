import { registerAs } from '@nestjs/config';
import { z } from 'zod';
import { readEnv } from '../config/env.js';
import { optional, secret, withDefault } from '../config/env.helpers.js';

/**
 * Every backend is off until its variable is set. Read by the config below
 * and by `instrument.ts`, which starts the SDKs before Nest builds anything.
 */
export const schema = z.object({
  SERVICE_NAME: withDefault('api').describe(
    "The service's name in traces and error reports.",
  ),
  GIT_SHA: optional().describe(
    "The commit being run (the image's build argument): the release in traces and error reports.",
  ),
  NODE_ENV: optional(),
  OBSERVE_APP_KEY: secret(optional()).describe(
    "NestJS Observe (traces, metrics, errors, logs): on when both keys are set (your project's API keys page, or `npx @nestjs/observe link`).",
  ),
  OBSERVE_APP_SECRET: secret(optional()).describe(
    'The secret that goes with OBSERVE_APP_KEY.',
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: optional()
    .pipe(z.url().optional())
    .describe(
      'OpenTelemetry export (traces and metrics over OTLP/HTTP), for a self-hosted backend: the Nestrix server (http://nestrix-server:4318), or any collector. On when set. The SDK also reads the standard OTEL_* variables itself (OTEL_TRACES_SAMPLER, OTEL_RESOURCE_ATTRIBUTES…). With NestJS Observe on too, Observe exports its traces there and the standalone SDK stays off.',
    ),
  OTEL_EXPORTER_OTLP_HEADERS: secret(optional()).describe(
    "The collector's credential, as `name=value,name=value`.",
  ),
});

export type ObservabilityEnv = Partial<z.output<typeof schema>>;

export const observabilityConfig = registerAs('observability', () => {
  const env = readEnv(schema);
  return {
    serviceName: env.SERVICE_NAME,
    release: env.GIT_SHA,
    environment: env.NODE_ENV,
    observeKey: env.OBSERVE_APP_KEY,
    observeSecret: env.OBSERVE_APP_SECRET,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
});
