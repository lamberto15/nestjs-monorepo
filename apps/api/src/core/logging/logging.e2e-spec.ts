import { Controller, Get } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { type NestNodeApplication, NodeAdapter } from '@nestjs/platform-node';
import { Test } from '@nestjs/testing';
import { createLogger } from './logging.js';
import { LoggingModule } from './logging.module.js';

@Controller('ping')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({ imports: [LoggingModule], controllers: [PingController] })
class TestModule {}

describe('request ids and the request log', () => {
  let app: NestNodeApplication;
  let lines: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = moduleRef.createNestApplication<NestNodeApplication>(
      new NodeAdapter(),
    );
    app.useLogger(createLogger({ level: 'log', json: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns a new X-Request-Id when the request has none', async () => {
    const response = await app.inject({ method: 'GET', url: '/ping' });
    const id = response.headers['x-request-id'];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // The line is written when the response finishes, just after inject() resolves.
    await vi.waitFor(() => {
      expect(lines.join('')).toContain('GET /ping 200');
    });
    expect(lines.join('')).toContain(id);
  });

  it('keeps a safe id from the client and replaces an unsafe one', async () => {
    const kept = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': 'client-id-12345' },
    });
    expect(kept.headers['x-request-id']).toBe('client-id-12345');
    const replaced = await app.inject({
      method: 'GET',
      url: '/ping',
      headers: { 'x-request-id': 'bad id\twith spaces' },
    });
    expect(replaced.headers['x-request-id']).not.toContain(' ');
  });
});
