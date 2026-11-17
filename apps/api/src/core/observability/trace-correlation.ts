import { trace } from '@opentelemetry/api';

/**
 * The fields that tie a log line to its trace: the active span's `traceId`,
 * so the line finds its trace in the collector. Empty outside a span, and
 * always when no SDK is started (the API's no-op). The logger's
 * `correlation()` returns this.
 */
export function traceCorrelation(): Record<string, string> {
  const context = trace.getActiveSpan()?.spanContext();
  return context && trace.isSpanContextValid(context)
    ? { traceId: context.traceId }
    : {};
}
