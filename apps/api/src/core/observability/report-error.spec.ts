import { SpanStatusCode, type Span } from '@opentelemetry/api';
import { reportError } from './report-error.js';

describe('reportError', () => {
  it('records the error on the span, with the ids that find its logs', () => {
    const span = {
      recordException: vi.fn(),
      setStatus: vi.fn(),
      setAttribute: vi.fn(),
    };
    const error = new Error('boom');
    reportError(
      error,
      { requestId: 'r-1', code: 'internal_error' },
      span as unknown as Span,
    );
    expect(span.recordException).toHaveBeenCalledWith(error);
    expect(span.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR });
    expect(span.setAttribute).toHaveBeenCalledWith('app.request_id', 'r-1');
    expect(span.setAttribute).toHaveBeenCalledWith(
      'app.error_code',
      'internal_error',
    );
  });

  it('does nothing outside a span', () => {
    expect(() => reportError(new Error('boom'), {}, undefined)).not.toThrow();
  });
});
