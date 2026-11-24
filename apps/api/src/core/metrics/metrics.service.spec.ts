import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import { recordMetrics } from '../../../test/metrics.js';
import {
  recordTelemetryFailure,
  resetTelemetryHealth,
} from '../observability/telemetry-health.js';
import { MetricsService } from './metrics.service.js';

let recorded: ReturnType<typeof recordMetrics>;

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  recorded = recordMetrics();
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetTelemetryHealth();
  await recorded.stop();
});

describe('MetricsService.collect()', () => {
  const failing = () => Promise.reject(new Error('Redis is away'));

  it('reports the gauges it read', async () => {
    const service = new MetricsService();
    service.collect('jobs', 'Jobs.', () => [
      { labels: { state: 'waiting' }, value: 3 },
    ]);
    service.collect('lag_seconds', 'Lag.', () => [{ value: 1.5 }], 's');

    expect(await recorded.read('jobs')).toEqual([
      { attributes: { state: 'waiting' }, value: 3 },
    ]);
    expect(await recorded.read('lag_seconds')).toEqual([
      { attributes: {}, value: 1.5 },
    ]);
    const [heap] = await recorded.read('nodejs_heap_size_limit_bytes');
    expect(heap!.value).toBeGreaterThan(0);
  });

  it('counts a read that fails, and still reports the others', async () => {
    const service = new MetricsService();
    service.collect('outbox_lag_seconds', 'Lag.', failing);
    service.collect('healthy', 'Still there.', () => [{ value: 1 }]);

    expect(await recorded.read('outbox_lag_seconds')).toEqual([]);
    expect(await recorded.read('healthy')).toEqual([
      { attributes: {}, value: 1 },
    ]);
    // Each collection so far read it once, and failed.
    const [failures] = await recorded.read('metric_read_failures');
    expect(failures!.attributes).toEqual({ metric: 'outbox_lag_seconds' });
    expect(failures!.value).toBeGreaterThanOrEqual(2);
  });

  it('stops reading once its app is closed', async () => {
    const service = new MetricsService();
    const read = vi.fn(() => [{ value: 1 }]);
    service.collect('closed', 'Gone.', read);
    service.onModuleDestroy();
    expect(await recorded.read('closed')).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('MetricsService and the global provider', () => {
  it('moves its instruments to a provider registered after it was made', async () => {
    // As with Nestrix, which registers its provider after the app booted.
    await recorded.stop();
    const service = new MetricsService();
    service.collect('late_gauge', 'Late.', () => [{ value: 7 }]);
    const counter = service.counter('late_counter');
    counter.add(1);
    recorded = recordMetrics();

    counter.add(2);
    expect(await recorded.read('late_counter')).toEqual([
      { attributes: {}, value: 2 },
    ]);
    expect(await recorded.read('late_gauge')).toEqual([
      { attributes: {}, value: 7 },
    ]);
  });

  it('moves the gauges on its timer too, when nothing records', async () => {
    vi.useFakeTimers();
    try {
      await recorded.stop();
      const service = new MetricsService();
      service.onModuleInit();
      service.collect('idle_gauge', 'Idle.', () => [{ value: 4 }]);
      recorded = recordMetrics();
      expect(await recorded.read('idle_gauge')).toEqual([]);
      vi.advanceTimersByTime(5_000);
      expect(await recorded.read('idle_gauge')).toEqual([
        { attributes: {}, value: 4 },
      ]);
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records nothing, and throws nothing, with no provider at all', () => {
    metrics.disable();
    const service = new MetricsService();
    expect(() => service.counter('nothing').add(1)).not.toThrow();
  });
});

describe('MetricsService telemetry_rejected', () => {
  it('has every refusal series at 0 before the first refusal', async () => {
    // An alert's increase() needs a sample before the count: a series that
    // appears already at 1 (NestJS Observe refuses once, then pauses) would
    // never raise it.
    new MetricsService();
    const points = await recorded.read('telemetry_rejected');
    for (const target of ['observe', 'otlp']) {
      for (const status of ['401', '403', '429']) {
        expect(points).toContainEqual({
          attributes: { target, status },
          value: 0,
        });
      }
    }
  });

  it('counts the refusals on top of that, those before it was made included', async () => {
    recordTelemetryFailure('observe', 401);
    new MetricsService();
    recordTelemetryFailure('otlp', 429);
    recordTelemetryFailure('otlp', 429);
    const points = await recorded.read('telemetry_rejected');
    expect(points).toContainEqual({
      attributes: { target: 'observe', status: '401' },
      value: 1,
    });
    expect(points).toContainEqual({
      attributes: { target: 'otlp', status: '429' },
      value: 2,
    });
    expect(points).toContainEqual({
      attributes: { target: 'otlp', status: '401' },
      value: 0,
    });
  });
});
