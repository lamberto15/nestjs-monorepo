import { createLogger, RedactingConsoleLogger } from './logging.js';
import { LogRedaction } from './redaction.js';

const capture = () => {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
};

describe('the logger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes one JSON object per line, with structured params as fields', () => {
    const lines = capture();
    createLogger({ level: 'log', json: true }, new LogRedaction()).log('Paid', {
      orderId: 7,
    });
    expect(JSON.parse(lines.join(''))).toMatchObject({
      level: 'log',
      message: 'Paid',
      orderId: 7,
    });
  });

  it('writes readable text when JSON is off', () => {
    const lines = capture();
    createLogger({ level: 'log', json: false }, new LogRedaction()).log(
      'hello',
    );
    expect(lines.join('')).toContain('hello');
    expect(() => JSON.parse(lines.join(''))).toThrow();
  });

  it('drops the levels below the configured one', () => {
    const lines = capture();
    const logger = createLogger(
      { level: 'warn', json: true },
      new LogRedaction(),
    );
    logger.log('quiet');
    logger.warn('loud');
    expect(lines.join('')).toContain('loud');
    expect(lines.join('')).not.toContain('quiet');
  });

  it('adds what correlation() returns to JSON and text lines', () => {
    class Traced extends RedactingConsoleLogger {
      protected override correlation() {
        return { traceId: 'abc123' };
      }
    }
    const lines = capture();
    new Traced({ json: true }, new LogRedaction()).log('hello');
    new Traced({ json: false }, new LogRedaction()).log('hello');
    const [json, text] = lines;
    expect(JSON.parse(json).traceId).toBe('abc123');
    expect(text).toContain('[traceId abc123]');
  });
});
