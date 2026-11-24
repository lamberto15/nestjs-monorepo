import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AiModelError, AiModule, AiService } from '@nestjs/ai';
import { Test } from '@nestjs/testing';
import { APICallError } from 'ai';
import { z } from 'zod';
import type { aiConfig } from './ai.config.js';
import { aiEnabled, aiModuleOptions } from './ai.models.js';

type Config = ReturnType<typeof aiConfig>;

/** The Messages API on loopback: no real call is ever made. */
describe('aiModuleOptions', () => {
  let server: Server;
  let status = 200;
  let body: unknown;
  const seen: { url?: string; headers: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers });
        res
          .writeHead(status, { 'content-type': 'application/json' })
          .end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
  });
  afterAll(() => {
    server.close();
  });

  const config = (values: Partial<Config> = {}): Config => ({
    apiKey: 'sk-ant-test',
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    model: 'claude-sonnet-5-5',
    cheapModel: 'claude-haiku-5-5',
    timeoutMs: 2000,
    maxOutputTokens: 1024,
    attempts: 2,
    cacheTtlSeconds: 0,
    runRetentionDays: 400,
    ...values,
  });
  const ask = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AiModule.forRoot(aiModuleOptions(config()))],
    }).compile();
    return moduleRef.get(AiService).generateObject({
      model: 'cheap',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
    });
  };

  it('is on while a key is set', () => {
    expect(aiEnabled(config())).toBe(true);
    expect(aiEnabled(config({ apiKey: undefined }))).toBe(false);
  });

  it('calls AI_BASE_URL (the host, /v1 added) with the key and reports the tokens', async () => {
    status = 200;
    body = {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    const result = await ask();
    expect(result.object).toEqual({ ok: true });
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(result.model.modelId).toBe('claude-haiku-5-5');
    expect(seen.at(-1)!.url).toBe('/v1/messages');
    expect(seen.at(-1)!.headers['x-api-key']).toBe('sk-ant-test');
  });

  it('makes one attempt only (the queue retries), and tells a retryable failure from a refusal', async () => {
    const before = seen.length;
    status = 529;
    body = { type: 'error', error: { type: 'overloaded_error', message: 'x' } };
    const overloaded = await ask().catch((error: unknown) => error);
    expect(overloaded).toBeInstanceOf(AiModelError);
    expect((overloaded as AiModelError).cause).toMatchObject({
      isRetryable: true,
    });
    expect(seen.length - before).toBe(1);

    status = 400;
    body = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'x' },
    };
    const refused = (await ask().catch((error: unknown) => error)) as Error;
    expect(APICallError.isInstance(refused.cause)).toBe(true);
    expect(refused.cause).toMatchObject({ isRetryable: false });
  });
});
