import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/** What an error report carries besides the error: ids that find the logs. */
export interface ErrorContext {
  requestId?: string;
  code?: string;
  status?: number;
}

/**
 * Reports an error the app handled but that should still be seen: the 5xx
 * the problem-details filter answers, a job's failure. It is recorded on the
 * active span, so whichever backend receives the traces shows it with its
 * request; nothing happens when no backend is on (the API's no-op span).
 */
export function reportError(
  error: unknown,
  context: ErrorContext = {},
  span: Span | undefined = trace.getActiveSpan(),
) {
  if (!span) {
    return;
  }
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
  if (context.requestId) {
    span.setAttribute('app.request_id', context.requestId);
  }
  if (context.code) {
    span.setAttribute('app.error_code', context.code);
  }
}
