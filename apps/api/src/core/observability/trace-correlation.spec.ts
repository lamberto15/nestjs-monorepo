import { trace } from '@opentelemetry/api';
import { traceCorrelation } from './trace-correlation.js';

describe('traceCorrelation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is empty outside a span, and when no SDK is started', () => {
    expect(traceCorrelation()).toEqual({});
  });

  it("is the active span's trace id", () => {
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: 1,
    };
    // Without an SDK there is no context manager to make a span active.
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      trace.wrapSpanContext(spanContext),
    );
    expect(traceCorrelation()).toEqual({ traceId: spanContext.traceId });
  });
});
