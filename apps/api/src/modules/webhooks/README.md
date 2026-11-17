# Webhooks

Outgoing webhooks of API clients and signed incoming webhooks of a tenant's
senders, on `@nestjs/webhooks` (its Postgres store in the `nest_webhooks`
schema).

## Outgoing

An API client subscribes endpoints to event types; each event it may read is
signed (Standard Webhooks: `webhook-id`, `webhook-timestamp`,
`webhook-signature`, `v1,` HMAC-SHA256 of `id.timestamp.body`), sent and
retried by the worker.

- Routes: `/v1/webhook-endpoints` and `/v1/webhook-deliveries` (the client's
  own key), `/v1/access/clients/:clientId/webhook-endpoints|webhook-deliveries`
  (a user with `Webhooks.manageEndpoints` and authority over the client,
  API_CLIENTS on; audited as the user's), `GET /v1/webhook-event-types`.
- The package's tenant is the API client: a client never sees another's
  endpoint or delivery (404).
- An endpoint's secret is shown once (create, `rotate-secret`) and stored
  encrypted under DATA_ENCRYPTION_KEYS. After a rotation both secrets sign
  for 24 hours.
- Every URL goes through safeFetch's address rules: no private, loopback,
  link-local or metadata address, https only; checked on create and update,
  and again at connect time on every attempt (the socket is pinned to the
  checked address, redirects are not followed). A refused address fails the
  delivery without a retry.
- Retries: 50 attempts, waits ×4 from 5 s up to 1 h. An endpoint failing for
  5 days is disabled. `POST …/webhook-deliveries/:id/retry` and
  `…/webhook-deliveries/retry` redeliver with the same `webhook-id`;
  `POST …/webhook-endpoints/:id/test` sends `webhook.test`.
- The log keeps each delivery's attempts and the last request sent (headers
  and which secrets signed it, never a secret). Finished deliveries older than
  WEBHOOKS_DELIVERY_RETENTION_DAYS (30) go every night at 03:35 UTC.
- A deleted API client's endpoints are deleted (`access.client-revoked`).

### A module's event as a webhook

A module turns its domain events into webhooks in its own imports. `data` is
the public payload: keys it doesn't declare are never sent. A client receives
the event only if it may `read` the `subject` (with the payload as the
record), redacted as for a read.

```ts
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { noteCreated } from './notes.events.js';

const noteWebhook = z.object({ id: z.uuid(), title: z.string() });

@Module({
  imports: [
    WebhooksModule.forFeature([
      {
        event: noteCreated, // defineEvent<NoteCreated>('note.created')
        subject: 'Note',
        description: 'A note was created.',
        data: noteWebhook,
      },
    ]),
  ],
})
export class NotesModule {}
```

The service publishes the event as usual (`events.publish(noteCreated, …)`
in its transaction); the outbox relays it to the subscribed clients.

## Incoming

A tenant's users with `Webhooks.manageSenders` register senders
(`/v1/webhook-senders`); each gets a secret, shown once and sealed at rest,
and a URL: `POST /v1/webhooks/tenants/:tenantId/senders/:name`. A call is
verified with that sender's secret (Standard Webhooks, 5 minute timestamp
tolerance, constant-time comparison), runs in its tenant, and a repeated
`webhook-id` is answered without running the handler again. Rotating keeps
the old secret for `graceSeconds` (default 1 day).

A module handles an event type with a method on one of its providers:

```ts
@Injectable()
export class NotePublishReceiver {
  constructor(private readonly notes: NotesService) {}

  @OnIncomingWebhook({
    type: 'note.publish-requested',
    description: 'Publishes a note.',
    data: z.object({ noteId: z.uuid() }),
    example: { noteId: '0192…' },
    delivery: 'Deduplicated by the webhook-id; answered 200 once handled.',
  })
  async publish({ webhook }: IncomingEventContext) {
    await this.notes.publish(webhook.payload.data);
    return { duplicate: false };
  }
}
```

`GET /v1/webhook-incoming-event-types` lists the declared types.

## Configuration

- `WEBHOOKS_WORKER` (on): this process sends deliveries (also needs a worker
  role, QUEUE_ROLE).
- `WEBHOOKS_ALLOW_LOOPBACK` (off): development and tests only; allows
  http and 127.0.0.1.
- `WEBHOOKS_DELIVERY_RETENTION_DAYS` (30).
- `DATA_ENCRYPTION_KEYS`: required.

The app must be created with `rawBody: true` for incoming signatures.
