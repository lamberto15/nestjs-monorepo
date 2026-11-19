# modules/inbox

`GET /v1/inbox`: one list of what waits on the caller in the current tenant,
newest first, cursor pages (`?source=` narrows to one). It keeps nothing: each
source reads its own state now and returns only what the caller may see.
`POST /v1/inbox/dismiss { key }` dismisses an item whose source allows it.

A module provides a source, nothing to register:

```ts
@InboxSourceOf('mention')
@Injectable()
export class MentionInbox implements InboxSource {
  items(user: Principal, { limit, after }: { limit: number; after?: string }) {
    // up to `limit` InboxEntry, newest first by UUIDv7 `id`, those with id < after
  }
  dismiss(user: Principal, id: string) {
    /* optional: mark it read */
  }
}
```

Remove: `pnpm module:remove inbox` ([removing-a-module](../../../../../docs/removing-a-module.md)).
