import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OutboxRelay } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { WebhookWorker } from '@nestjs/webhooks';
import { SharedOutboxModule } from '../src/core/outbox/outbox.module.js';
import { WebhooksModule } from '../src/modules/webhooks/webhooks.module.js';
import { accessModules } from './access.js';

/**
 * What an e2e test of webhooks boots: principals and permissions
 * (accessModules), the outbox and the webhooks module. Set OUTBOX_RELAY,
 * WEBHOOKS_WORKER and SCHEDULER off and WEBHOOKS_ALLOW_LOOPBACK on in the
 * test (vi.hoisted), with DATA_ENCRYPTION_KEYS, and drive deliveries with
 * `deliverWebhooks()`.
 */
export const webhookModules = () => [
  ...accessModules(),
  SharedOutboxModule,
  WebhooksModule,
];

/**
 * Everything after the commit: the outbox relays the domain events (to
 * WebhookPublisher) and the messages they dispatched (the package's
 * fan-out), then the worker sends one batch.
 */
export async function deliverWebhooks(app: NestNodeApplication) {
  const relay = app.get(OutboxRelay);
  await relay.runOnce();
  await relay.runOnce();
  return app.get(WebhookWorker).runOnce();
}

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  raw: string;
  body: { type: string; timestamp: string; data: Record<string, unknown> };
}

/** An HTTP server on 127.0.0.1 that records the webhooks it receives (WEBHOOKS_ALLOW_LOOPBACK=on). */
export async function webhookReceiver() {
  const received: ReceivedWebhook[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, raw, body: JSON.parse(raw) });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
