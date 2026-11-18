# modules/realtime

Live events to browsers and apps: socket.io, namespace `/realtime`, on every
instance (Redis adapter). `Realtime` pushes from any process, the worker
included (it publishes through `@socket.io/redis-emitter`).

## Connecting

- Browser: `io('/realtime', { withCredentials: true, transports: ['websocket'] })`
  (the session cookie). Token client: `auth: { token: '<access token>' }`.
  API client: `auth: { token: 'sk_…' }`. Anyone else: `connect_error`
  `unauthorized` (not retried); a failure of ours: `unavailable`.
- Rooms, joined before the client hears it is connected: the tenant's
  (`tenant:<id>`), the principal's in its tenant, the user's account room
  (`principal:user:<id>`, not for an impersonating administrator), and a
  private one for the session, the token family (`sid`) or the API key.
  `socket.emitWithAck('whoami')` answers who and which rooms.
- A socket ends when its credential does: session sign-out, family or key
  revocation, deactivated membership, user, client or tenant (events below),
  a browser session at its idle timeout or maximum age (the tenant's limits
  under the environment's, `SessionLifetime`; at that time the session is
  read again, untouched, and a request that used it since moves the idle
  deadline), an access token at its `exp`, an API key at its expiry, and a
  key that stops working at the next check (every 10 minutes). The server closes it
  (`io server disconnect`); connect again with a working credential. A
  handshake with the token of a revoked family is refused.
- A tenant switch issues a new session: reconnect after switching.

## Pushing

Declare the event next to the code that pushes it, import `RealtimeModule`,
inject `Realtime`:

```ts
// thumbnails.events.ts
export const thumbnailReady = defineRealtimeEvent(
  'thumbnail.ready',
  z.object({ fileKey: z.string() }), // ids and small facts, never content
);

// thumbnails.module.ts: imports: [RealtimeModule]
this.realtime.toPrincipal(owner, thumbnailReady, { fileKey });
this.realtime.toPrincipals(watchers, noteCommented, { noteId }); // a record's watchers
this.realtime.toTenant(announcement, { … });
```

The room is the current context's tenant (a request's, an event handler's);
outside any tenant `toPrincipal` goes to the user's account room. Push after
the change committed; a push never fails the request. Outside production a
payload off its schema throws where it is written.

**A domain event reaching sockets** has no registry and no channel: the module
that owns the event subscribes, in the worker, in the event's tenant, and
works out the audience it knows (watchers, the owner), checking who may read:

```ts
@OnDomainEvent(noteCommented, { consumer: 'note-realtime' })
async push({ noteId, watcherKeys }: NoteCommented) {
  this.realtime.toPrincipals(watcherKeys.map(parseKey), noteCommentedLive, { noteId });
}
```

## Events that end sockets

`@OnEvent` listeners (realtime.listeners.ts), emitted by the owner after
the change commits: `auth.session-ended`, `auth.token-session-ended`,
`access.member-deactivated` (exist), and `access.user-deactivated`
`{ userId }`, `access.client-revoked` `{ clientId, tenantId }`,
`access.keys-revoked` `{ keyIds }`, `tenancy.tenant-deactivated`
`{ tenantId }`.

## Wiring

`setupRealtime(app)` in main.ts before `listen()` (the adapter; an app
without it serves no gateway). No environment variables. Messages are not
rate limited (the limit is HTTP's); a message handler that queries tenant
data needs `ClsInterceptor` for its context.

Remove: delete this folder and its line in `app.module.ts` (and
`setupRealtime`, and the modules that push).
