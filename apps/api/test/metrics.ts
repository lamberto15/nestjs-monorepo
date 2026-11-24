import { metrics } from '@opentelemetry/api';
import {
  MeterProvider,
  MetricReader,
  type MetricData,
} from '@opentelemetry/sdk-metrics';

/** A reader collected on demand: the SDK ships none, only periodic ones. */
class OnDemandReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

/**
 * A MeterProvider registered globally, as Nestrix registers its own, for a
 * test to read what the app recorded: `read(name)` collects now and gives
 * that metric's points (`value` a number, or a histogram's `{ count, sum,
 * buckets }`). Call it before the app boots and `stop()` after it closes.
 */
export function recordMetrics() {
  const reader = new OnDemandReader();
  const provider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  return {
    async read(name: string) {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length > 0) throw errors[0];
      const found = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === name);
      return found.flatMap((metric: MetricData) =>
        metric.dataPoints.map(({ attributes, value }) => ({
          attributes,
          value: value as number,
        })),
      );
    },
    async stop() {
      metrics.disable();
      await provider.shutdown();
    },
  };
}
