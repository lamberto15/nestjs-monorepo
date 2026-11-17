import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Injectable, Module } from '@nestjs/common';
import { HttpClient, HttpClientModule } from '@nestjs/http-client';
import { ResilienceService } from '@nestjs/resilience';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { SharedHttpClientModule } from './http-client.module.js';

let calls = 0;
const server = createServer((request, response) => {
  calls++;
  // The first call fails: an idempotent request is retried.
  if (calls === 1) {
    response.statusCode = 503;
    return void response.end();
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ userAgent: request.headers['user-agent'] }));
});

@Injectable()
class Consumer {
  constructor(readonly http: HttpClient) {}
}

describe('http client (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    @Module({
      imports: [
        HttpClientModule.register({ baseUrl: `http://127.0.0.1:${port}` }),
      ],
      providers: [Consumer],
    })
    class ConsumerModule {}
    app = await bootModules(SharedHttpClientModule, ConsumerModule);
  });
  afterAll(async () => {
    await app.close();
    server.close();
  });

  it('sends the service as user-agent and retries a failed GET', async () => {
    const response = await app
      .get(Consumer)
      .http.get<{ userAgent: string }>('/');
    expect(response.data.userAgent).toBe('api');
    expect(calls).toBe(2);
  });

  it('gives services the resilience policies', () => {
    expect(app.get(ResilienceService)).toBeDefined();
  });
});
