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
- A deleted API client's endpoints are deleted, in the worker after the delete commits (the `access.api-client-deleted` domain event, retried until it succeeds).
- Built in: `security.api-key-rotated` (iam/api-clients' event, relayed in
  `webhooks.security.ts`) goes to the rotated client only.

### Which records' events a client receives

A record's events go to the client that owns the record (`ownerId` `client:<id>`).
`GET|PUT /v1/access/clients/{clientId}/webhook-scope` (`Webhooks.manageEndpoints`, authority
over the client, a recent sign-in to change it, audited) sets `{ scope }`: `own` (the default)
only those; `tenant` also the records users and other clients own. Either way a client
receives a record only if its own role may `read` it, redacted to the fields it may read.
Stored in `webhook_client_scopes` (gone with the client). Events from `forFeature()` that are
no record's have no owner: they follow the read permission alone.

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

### A record's events as webhooks

`WebhooksModule.forRecord(RECORD)` in the feature's imports offers `<item>.created|updated|deleted|restored` (`testItem.created`…). `data` is the record as the API shows it (no `can`, no add-on keys). A client receives it only for a record it may `read`, as it was before a deletion, redacted as for a read.

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

That is all a feature writes to receive a signed webhook. What the module does
before the handler runs: the sender is found in the tenant named in the URL (an
unknown one is the same 401 as a bad signature); the signature is checked on the
raw body (`rawBody: true`), in constant time, with a 5 minute timestamp window
(a replay of an old capture is refused); a repeated `webhook-id` is answered
without running the handler (the inbox), and the handler's writes commit with
that record. The route is `@Public()` and needs no CSRF exclusion: a sender is a
server and sends no `Origin`, so the protection lets it through
(`csrfExclusions` in core/http is for pages that post across sites, like a SAML
identity provider). To test a handler, sign a body as Standard Webhooks does
with the sender's secret (`incoming-senders.e2e-spec.ts`). A secret fixed in
the environment for one global sender is not offered: each tenant registers its
senders.

## Configuration

- `WEBHOOKS_WORKER` (on): this process sends deliveries (also needs a worker
  role, QUEUE_ROLE).
- `WEBHOOKS_ALLOW_LOOPBACK` (off): development and tests only; allows
  http and 127.0.0.1.
- `WEBHOOKS_DELIVERY_RETENTION_DAYS` (30).
- `DATA_ENCRYPTION_KEYS`: required.

The app must be created with `rawBody: true` for incoming signatures.

## Metrics

`webhook_delivery_lag_seconds` on a worker's `/metrics`: how long the most overdue outgoing delivery has waited (0 when none). Shared state: aggregate with max().

Add-on: `pnpm feature:add --addons webhooks` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `webhooks.addon.js`): a record's changes as webhooks for API clients.
