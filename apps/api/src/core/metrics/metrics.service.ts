import { setTimeout as sleep } from 'node:timers/promises';
import { getHeapStatistics } from 'node:v8';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  type MetricOptions,
  type ObservableResult,
  metrics,
} from '@opentelemetry/api';
import { readEnv } from '../config/env.js';
import { schema } from '../observability/observability.config.js';
import {
  COUNTED_TARGETS,
  onTelemetryRejected,
  REFUSAL_STATUSES,
} from '../observability/telemetry-health.js';

/** A read that takes longer (Redis or PostgreSQL away) is given up: the collection goes on without it. */
const COLLECT_TIMEOUT_MS = 2_000;
const TIMED_OUT = Symbol('timed out');

/** How often the global provider is checked while nothing records: Nestrix registers its own a moment after the app started. */
const REBIND_INTERVAL_MS = 5_000;

/** One value of a collected gauge, with its labels. */
export type MetricSample<Label extends string> = {
  labels?: Partial<Record<Label, string>>;
  value: number;
};

/** Makes an instrument on a meter; returns what undoes it (an observable's callback). */
type Bind = (meter: Meter) => (() => void) | void;

/**
 * The process's metrics, on the OpenTelemetry API: whichever MeterProvider
 * is registered globally exports them (Nestrix's, over OTLP), and with none
 * they cost nothing. A module declares its own in its own folder, with no
 * list here: `counter()`, `histogram()`, or a gauge read at collection time
 * with `collect()`.
 *
 * Instruments are remade whenever the global provider changes. The API has
 * no proxy provider: `metrics.getMeter()` before one is registered returns
 * the no-op meter for good, and Nestrix registers its provider
 * asynchronously after boot (and removes it again when the endpoint takes no
 * metrics). So every record compares the provider (one global lookup), and a
 * timer does for the gauges, which nothing records.
 */
@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Metrics');
  private readonly meterName = readEnv(schema).SERVICE_NAME;
  private readonly binds: Bind[] = [];
  private unbinds: (() => void)[] = [];
  private provider?: MeterProvider;
  private meter?: Meter;
  private timer?: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  readonly databaseAcquire = this.histogram(
    'db_connection_acquire_duration_seconds',
    {
      description:
        'Time waiting for a database connection, including connection establishment.',
      unit: 's',
      advice: {
        explicitBucketBoundaries: [
          0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10,
        ],
      },
    },
  );

  readonly databaseQuery = this.histogram('db_query_duration_seconds', {
    description:
      'Client-observed database command duration, excluding pool acquisition; includes network and lock waits.',
    unit: 's',
    advice: {
      explicitBucketBoundaries: [
        0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30,
      ],
    },
  });

  // No `_total` on a counter: the Prometheus translation adds it back
  // (db_failures_total), so the names alerts read stay the same.
  readonly databaseFailures = this.counter(
    'db_failures',
    {
      description:
        'Database connection-acquisition failures and statement cancellations.',
    },
    [{ code: 'database_busy' }, { code: 'database_timeout' }],
  );

  readonly databaseIncidents = this.counter(
    'db_incidents',
    {
      description:
        'Database incidents, including those whose activity snapshot was suppressed.',
    },
    ['database_busy', 'database_timeout', 'slow_query'].map((trigger) => ({
      trigger,
    })),
  );

  /** Calls to routes marked `@Deprecated()`: when it stops rising, the route can go. */
  readonly deprecatedCalls = this.counter('deprecated_route_calls', {
    description: 'Calls to deprecated routes, by route pattern.',
  });

  /** Gauge reads that failed or timed out, by metric: the gauge keeps its last value, so this is what an alert reads. */
  private readonly readFailures = this.counter('metric_read_failures', {
    description:
      'Gauge reads at collection time that failed or took over 2 s, by metric; the gauge keeps its last value.',
  });

  /**
   * Telemetry the collector turned away (401, 403, 429), by pipeline: a dead
   * export the app itself would never notice (observability/telemetry-health.ts).
   * Every series a refusal can make starts at 0: an alert's increase() needs
   * a sample before the first count, and a refusal that happens once
   * (NestJS Observe pauses after the first 401 or 429) would otherwise show
   * up already at 1 and never raise it.
   */
  readonly telemetryRejected = this.counter(
    'telemetry_rejected',
    {
      description:
        'Telemetry uploads refused by the collector, by target (observe, otlp) and HTTP status.',
    },
    COUNTED_TARGETS.flatMap((target) =>
      REFUSAL_STATUSES.map((status) => ({ target, status: String(status) })),
    ),
  );

  constructor() {
    this.unsubscribe = onTelemetryRejected((target, status) =>
      this.telemetryRejected.add(1, { target, status: String(status) }),
    );
    // Not among Nestrix's runtime metrics (the conventions deprecate the
    // heap limit): what a heap alert compares the used heap with.
    this.collect(
      'nodejs_heap_size_limit_bytes',
      "V8's heap limit (--max-old-space-size plus the young generation).",
      () => [{ value: getHeapStatistics().heap_size_limit }],
      'By',
    );
  }

  onModuleInit() {
    this.timer = setInterval(() => this.sync(), REBIND_INTERVAL_MS).unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    this.unsubscribe();
    // A closed app's gauges stop reading (its pool and Redis are gone).
    for (const undo of this.unbinds.splice(0)) undo();
    this.binds.length = 0;
  }

  /** A counter; `zeros`: the series that start at 0, for an alert's increase(). */
  counter(
    name: string,
    options: MetricOptions = {},
    zeros: Attributes[] = [],
  ): Counter {
    const current = this.declare(
      (meter) => meter.createCounter(name, options),
      (counter) => {
        for (const attributes of zeros) counter.add(0, attributes);
      },
    );
    return {
      add: (value, attributes, context) =>
        current().add(value, attributes, context),
    };
  }

  /** A histogram; buckets go in `options.advice.explicitBucketBoundaries`. */
  histogram(name: string, options: MetricOptions = {}): Histogram {
    const current = this.declare((meter) =>
      meter.createHistogram(name, options),
    );
    return {
      record: (value, attributes, context) =>
        current().record(value, attributes, context),
    };
  }

  /**
   * A gauge whose values `read` gives at each collection (labelled samples).
   * A read that fails or takes over 2 s is logged and counted in
   * `metric_read_failures{metric}`; one broken source never fails the
   * collection of the others.
   */
  collect<Label extends string = never>(
    name: string,
    description: string,
    read: () => Promise<MetricSample<Label>[]> | MetricSample<Label>[],
    unit?: string,
  ) {
    const observe = async (result: ObservableResult) => {
      try {
        const samples = await Promise.race([
          read(),
          sleep(COLLECT_TIMEOUT_MS, TIMED_OUT, { ref: false }),
        ]);
        if (samples === TIMED_OUT) {
          throw new Error(`no answer in ${COLLECT_TIMEOUT_MS} ms`);
        }
        for (const sample of samples) {
          result.observe(sample.value, sample.labels);
        }
      } catch (error) {
        this.readFailures.add(1, { metric: name });
        this.logger.warn(`${name} not collected: ${(error as Error).message}`);
      }
    };
    this.add((meter) => {
      const gauge = meter.createObservableGauge(name, { description, unit });
      gauge.addCallback(observe);
      return () => gauge.removeCallback(observe);
    });
  }

  /** The current instrument made by `create`, remade (and `seed`ed) on each new provider. */
  private declare<I>(
    create: (meter: Meter) => I,
    seed?: (instrument: I) => void,
  ) {
    let instrument: I | undefined;
    this.add((meter) => {
      instrument = create(meter);
      seed?.(instrument);
    });
    return () => {
      this.sync();
      return instrument!;
    };
  }

  private add(bind: Bind) {
    this.binds.push(bind);
    // A changed provider rebinds them all, this one included.
    if (!this.sync()) this.run(bind);
  }

  /** Rebinds every instrument when the global provider changed; true when it did. */
  private sync() {
    const provider = metrics.getMeterProvider();
    if (provider === this.provider) return false;
    this.provider = provider;
    for (const undo of this.unbinds.splice(0)) undo();
    this.meter = provider.getMeter(this.meterName);
    for (const bind of this.binds) this.run(bind);
    return true;
  }

  private run(bind: Bind) {
    const undo = bind(this.meter!);
    if (undo) this.unbinds.push(undo);
  }
}
