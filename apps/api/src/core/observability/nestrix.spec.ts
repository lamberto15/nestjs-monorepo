import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { createHttpAdapter } from '../http/http-setup.js';
import { LogRedaction } from '../logging/redaction.js';
import { nestrixModule, otlpHeaders, redactedQueryKeys } from './nestrix.js';
import { nestrixEnabled, observeConfigured } from './observability.config.js';

describe('switches', () => {
  it('turn Nestrix on only when Observe is not there to export', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' };
    const observe = { OBSERVE_APP_KEY: 'k', OBSERVE_APP_SECRET: 's' };
    expect(nestrixEnabled({})).toBe(false);
    expect(observeConfigured({ OBSERVE_APP_KEY: 'k' })).toBe(false);
    expect(observeConfigured(observe)).toBe(true);
    expect(nestrixEnabled(endpoint)).toBe(true);
    expect(nestrixEnabled({ ...endpoint, ...observe })).toBe(false);
    expect(nestrixEnabled(observe)).toBe(false);
  });
});

describe('otlpHeaders', () => {
  it('reads the standard variable’s format', () => {
    expect(otlpHeaders('x-key=a%3Db, other = c ,broken')).toEqual({
      'x-key': 'a=b',
      other: 'c',
    });
    expect(otlpHeaders(undefined)).toEqual({});
  });
});

describe('redactedQueryKeys', () => {
  it("lists the registry's names a query can carry", () => {
    const names = redactedQueryKeys(new LogRedaction());
    // The OIDC callbacks' query: the authorization code and its state.
    expect(names).toEqual(expect.arrayContaining(['code', 'state']));
    // A plain field name masks as a query parameter too.
    expect(names).toEqual(expect.arrayContaining(['token', 'password']));
    // A body field is no query parameter.
    expect(names.some((name) => name.includes('.'))).toBe(false);
  });
});

@Controller()
class PingController {
  @Get('ping')
  ping() {
    return 'ok';
  }

  @Get('health')
  health() {
    return 'ok';
  }
}

describe('Nestrix against a collector', () => {
  let collector: Server;
  const keys: (string | string[] | undefined)[] = [];
  const traces: string[] = [];

  beforeAll(async () => {
    collector = createServer((request, response) => {
      const body: Buffer[] = [];
      request.on('data', (chunk: Buffer) => body.push(chunk));
      request.on('end', () => {
        if (request.url === '/v1/traces') {
          keys.push(request.headers['x-collector-key']);
          traces.push(Buffer.concat(body).toString('latin1'));
        }
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      collector.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(() => new Promise((resolve) => collector.close(resolve)));

  it(
    'exports the trace of a request it served, by route, without its secrets',
    { timeout: 30_000 },
    async () => {
      const { port } = collector.address() as AddressInfo;
      vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', `http://127.0.0.1:${port}`);
      // As the config reads it (it may come from a secret file).
      vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'x-collector-key=from-config');
      vi.stubEnv('SERVICE_NAME', 'nestrix-spec');
      vi.stubEnv('OBSERVE_APP_KEY', '');

      @Module({
        imports: [
          ConfigModule.forRoot({ ignoreEnvFile: true }),
          nestrixModule(),
        ],
        controllers: [PingController],
      })
      class TestModule {}

      const app = await NestFactory.create<NestNodeApplication>(
        TestModule,
        createHttpAdapter(),
        { logger: false },
      );
      await app.listen(0, '127.0.0.1');
      const url = await app.getUrl();
      // An OIDC callback's query: the code and the state are secrets.
      await fetch(`${url}/ping?code=THE-CODE-1234&state=THE-STATE-5678&page=2`);
      await fetch(`${url}/health`);
      // Closing flushes what is buffered.
      await app.close();

      expect(keys).toContain('from-config');
      const exported = traces.join('\n');
      expect(exported).toContain('GET /ping');
      expect(exported).toContain('nestrix-spec');
      expect(exported).toContain('page=2');
      expect(exported).not.toContain('THE-CODE-1234');
      expect(exported).not.toContain('THE-STATE-5678');
      expect(exported).not.toContain('/health');
    },
  );
});
