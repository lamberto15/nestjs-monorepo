import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { LogRedaction } from '../logging/redaction.js';
import {
  countRefusals,
  exportFailureStatus,
  observeConfigured,
  otelSdkEnabled,
  redactedQueryParams,
  startOpenTelemetry,
} from './telemetry.js';

describe('switches', () => {
  it('start the standalone SDK only when Observe is not there to export', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' };
    const observe = { OBSERVE_APP_KEY: 'k', OBSERVE_APP_SECRET: 's' };
    expect(otelSdkEnabled({})).toBe(false);
    expect(observeConfigured({})).toBe(false);
    expect(observeConfigured({ OBSERVE_APP_KEY: 'k' })).toBe(false);
    expect(observeConfigured(observe)).toBe(true);
    expect(otelSdkEnabled(endpoint)).toBe(true);
    expect(otelSdkEnabled({ ...endpoint, ...observe })).toBe(false);
    expect(otelSdkEnabled(observe)).toBe(false);
  });
});

describe('countRefusals', () => {
  const exporterThatFailsWith = (error: unknown) => ({
    export(
      _items: unknown,
      done: (result: { code: number; error?: unknown }) => void,
    ) {
      done({ code: 1, error });
    },
  });

  it('counts a collector that refuses, and still answers the SDK', () => {
    const record = vi.fn();
    const done = vi.fn();
    countRefusals(exporterThatFailsWith({ code: 429 }), record).export(
      [],
      done,
    );
    expect(record).toHaveBeenCalledWith('otlp', 429);
    expect(done).toHaveBeenCalledWith({ code: 1, error: { code: 429 } });
  });

  it('does not count a success', () => {
    const record = vi.fn();
    const exporter = {
      export(_items: unknown, done: (result: { code: number }) => void) {
        done({ code: 0 });
      },
    };
    countRefusals(exporter, record).export([], vi.fn());
    expect(record).not.toHaveBeenCalled();
  });

  it('reads the status of the failures the exporters really make', () => {
    // OTLPExporterError(statusMessage, statusCode): a 401 or 403.
    expect(exportFailureStatus({ name: 'OTLPExporterError', code: 401 })).toBe(
      401,
    );
    // A 429 (or 502, 503, 504) comes back "retryable", with no code.
    expect(
      exportFailureStatus(new Error('Export failed with retryable status')),
    ).toBe(429);
    // A timeout or a refused connection is not a collector turning us away.
    expect(exportFailureStatus(new Error('Request timed out'))).toBeUndefined();
    expect(exportFailureStatus(undefined)).toBeUndefined();
  });
});

describe('redactedQueryParams', () => {
  it("lists the registry's query names and the instrumentation's own", () => {
    const names = redactedQueryParams(new LogRedaction());
    // The OIDC callbacks' query: the authorization code and its state.
    expect(names).toEqual(expect.arrayContaining(['code', 'state']));
    // A plain field name masks as a query parameter too.
    expect(names).toEqual(expect.arrayContaining(['token', 'password']));
    // The instrumentation's defaults, which a list replaces.
    expect(names).toEqual(
      expect.arrayContaining(['sig', 'X-Amz-Signature', 'AWSAccessKeyId']),
    );
    // A body field is no query parameter.
    expect(names.some((name) => name.includes('.'))).toBe(false);
  });
});

describe('OpenTelemetry against a collector', () => {
  let collector: Server;
  const received: string[] = [];
  const keys: (string | string[] | undefined)[] = [];
  const traces: string[] = [];

  beforeAll(async () => {
    collector = createServer((request, response) => {
      received.push(`${request.method} ${request.url}`);
      const body: Buffer[] = [];
      request.on('data', (chunk: Buffer) => body.push(chunk));
      request.on('end', () => {
        if (request.url === '/v1/traces') {
          keys.push(request.headers['x-collector-key']);
          traces.push(Buffer.concat(body).toString());
        }
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(() => new Promise((resolve) => collector.close(resolve)));

  it(
    'exports the trace of a request it served, without its secrets',
    { timeout: 30_000 },
    async () => {
      const { port } = collector.address() as AddressInfo;
      const endpoint = `http://127.0.0.1:${port}`;
      // The exporters read the process's environment, as in the app.
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', endpoint);
      vi.stubEnv('OTEL_SERVICE_NAME', '');
      vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', undefined);
      const sdk = await startOpenTelemetry({
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        // The credential as the config reads it (it may come from a secret file).
        OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=read-from-a-file',
        SERVICE_NAME: 'telemetry-spec',
      });
      expect(sdk).toBeDefined();
      // Only for the moment the exporters were built.
      expect(process.env.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
      // http is patched as it loads: a library's own require('http') is.
      const { createServer: createApp, get } = createRequire(import.meta.url)(
        'node:http',
      ) as typeof import('node:http');
      const app = createApp((_request, response) => response.end('ok'));
      await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
      await new Promise<void>((resolve, reject) =>
        get(
          // An OIDC callback's query: the code and the state are secrets.
          `http://127.0.0.1:${(app.address() as AddressInfo).port}/ping?code=THE-CODE-1234&state=THE-STATE-5678&page=2`,
          (response) => {
            response.resume();
            response.on('end', resolve);
          },
        ).on('error', reject),
      );
      await new Promise((resolve) => app.close(resolve));
      await sdk!.shutdown();
      expect(received).toContain('POST /v1/traces');
      expect(process.env.OTEL_SERVICE_NAME).toBe('telemetry-spec');
      expect(keys).toContain('read-from-a-file');
      const exported = traces.join('\n');
      expect(exported).toContain('page=2');
      expect(exported).not.toContain('THE-CODE-1234');
      expect(exported).not.toContain('THE-STATE-5678');
    },
  );
});
