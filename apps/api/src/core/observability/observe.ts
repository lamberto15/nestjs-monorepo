import {
  ConditionalModule,
  ConfigModule,
  type ConfigType,
} from '@nestjs/config';
import * as nestMail from '@nestjs/mail';
import { createObserveModule } from '@nestjs/observe';
import { readEnv } from '../config/env.js';
import { logRedaction } from '../logging/redaction.js';
import {
  type ObservabilityEnv,
  observabilityConfig,
  observeConfigured,
  schema,
} from './observability.config.js';

/**
 * NestJS Observe (@nestjs/observe): traces of every request, job and
 * outgoing call, runtime metrics and errors, with the trace id in every log
 * line. A hosted service: it starts only when OBSERVE_APP_KEY and
 * OBSERVE_APP_SECRET are set, and the app runs the same without it.
 *
 * With `OTEL_EXPORTER_OTLP_ENDPOINT` set as well, Observe joins the
 * OpenTelemetry setup instead of running beside a second SDK
 * (`observeOtlpOptions`; Nestrix then stays off, nestrix.ts). `x-request-id` from the proxy or the
 * client becomes the trace id (the SDK's default), so one id follows a
 * request through the logs and the traces.
 */
/**
 * The mail transport classes @nestjs/mail exports (every `*Transport`, found
 * by name so a transport added in a later release is covered).
 */
const mailTransportClasses = Object.entries(nestMail)
  .filter(
    ([name, value]) =>
      name.endsWith('Transport') && typeof value === 'function',
  )
  .map(([, value]) => value as abstract new (...args: never[]) => unknown);

/** The key @nestjs/locks stamps on a method wrapped by @OnOneInstance()/@WithoutOverlapping(). */
const LOCK_JOB_KEY = 'nestjs:locks:job';

/** Whether the instance's class has a method @nestjs/locks wrapped. */
const hasLockedJob = (instance: object) => {
  for (
    let proto = Object.getPrototypeOf(instance) as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      const method = Object.getOwnPropertyDescriptor(proto, key)
        ?.value as unknown;
      if (
        typeof method === 'function' &&
        Object.getOwnPropertySymbols(method).some(
          (symbol) => symbol.description === LOCK_JOB_KEY,
        )
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Providers Observe must leave unproxied (its `skipInstrumentation`). Observe
 * runs a method with its proxy as `this`, which breaks two things keyed by the
 * real instance:
 *
 * - the mail transports: @nestjs/mail compiles `#field` to a WeakMap
 *   (`__classPrivateFieldGet`), which Observe doesn't detect as a private
 *   member, so every send throws "Cannot read private member";
 * - every job decorated with @OnOneInstance()/@WithoutOverlapping():
 *   @nestjs/locks finds the job's runner in a WeakMap keyed by the instance
 *   (`jobRunners.get(this)`), so the call throws before the job runs.
 *
 * Lock-decorated classes are found by the marker @nestjs/locks puts on the
 * method, so a new job is covered without being listed. Custom code, because
 * Observe has no per-class opt-out other than this hook (issue #392). The
 * cost: no spans for those classes' own methods; their outgoing calls still
 * trace. Drop this once @nestjs/observe or @nestjs/locks handles proxies.
 */
export const skipObserve = (instance: unknown): boolean =>
  typeof instance === 'object' &&
  instance !== null &&
  (mailTransportClasses.some((type) => instance instanceof type) ||
    hasLockedJob(instance));

export const { ObserveModule, ObserveInstrument } = createObserveModule({
  skipInstrumentation: skipObserve,
});

/** The `instrument` option of `NestFactory.create()`: Observe's hook when it is configured, nothing otherwise. */
export const observeInstrument = (env: ObservabilityEnv = readEnv(schema)) =>
  observeConfigured(env) ? ObserveInstrument : undefined;

/**
 * What Observe does about OpenTelemetry. With the OTLP endpoint set, Observe
 * reads and sends W3C `traceparent` (`openTelemetry`) and exports its spans
 * to that collector (`otlp: true` reads the endpoint, headers, protocol and
 * service name from the standard `OTEL_*` variables), and Nestrix is not
 * started (nestrix.ts), so http and pg are instrumented once and each trace
 * is exported once.
 */
export const observeOtlpOptions = (endpoint: string | undefined) =>
  endpoint?.trim() ? { openTelemetry: true, otlp: true } : {};

/** The Observe module when it's configured, nothing otherwise. */
export const observeModule = () =>
  ConditionalModule.registerWhen(
    ObserveModule.forRootAsync({
      imports: [ConfigModule.forFeature(observabilityConfig)],
      inject: [observabilityConfig.KEY],
      useFactory: (config: ConfigType<typeof observabilityConfig>) => ({
        appKey: config.observeKey!,
        appSecret: config.observeSecret!,
        serviceId: config.serviceName,
        serviceVersion: config.release,
        ...observeOtlpOptions(config.otlpEndpoint),
        http: {
          tags: { env: config.environment ?? 'development' },
          ignore: ['/health', '/health/live'],
        },
        // Passwords, tokens and keys never leave the process: the SDK's own
        // rules, plus the names the app's registry (core/logging/redaction.ts)
        // masks in the logs.
        redaction: {
          enabled: true,
          useDefaultPatterns: true,
          keys: logRedaction.paths().filter((path) => !path.includes('.')),
        },
      }),
    }),
    (env) => observeConfigured(readEnv(schema, env)),
    // A slow start (the first Observe import under load) must not time out.
    { debug: false, timeout: 60_000 },
  );
