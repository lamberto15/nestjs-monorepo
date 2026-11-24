# core/outbox: the transactional outbox and domain events

`@nestjs/outbox` on PostgreSQL (`SharedOutboxModule`, global), with domain events on top (`events.ts`).

- **Define** an event where its module owns it: `export const NOTE_PUBLISHED = defineEvent<{ noteId: string }>('note.published')`. There is no central list.
- **Publish** in the transaction of the change: `await this.events.publish(NOTE_PUBLISHED, { noteId }, { key: noteId })` inside a `@Transactional()` method (`Events`). Outside one it throws. The event is stored with the tenant of the context. An event nothing subscribes to is not stored (the outbox would retry it and hold back the later events of its key).
- **Subscribe** in any module: `@OnDomainEvent(NOTE_PUBLISHED, { consumer: 'search-index' })` on a provider's method. It runs in the worker (APP_ROLE worker or all) within about a second of the commit, in the tenant the event was published in, once per consumer name (the inbox); keep the name stable. A `NonRetryableMessageError` dead-letters at once; other errors retry with backoff (10 s to minutes) and then dead-letter.
- **Retention:** `OutboxRetentionJob` (04:20 UTC, one instance) deletes dead letters older than OUTBOX_DEAD_LETTER_RETENTION_DAYS and inbox records older than OUTBOX_INBOX_RETENTION_DAYS (which must not be shorter).
- **Schema:** the package keeps its tables in `nest_outbox`. The app's role may not create tables, so they come from the migration `background-stores` (run as the owner); the store only checks them at start. After upgrading the package, add a migration for its new schema version: `pnpm exec nest-outbox sql --from <n> --statement-breakpoints` into a `drizzle-kit generate --custom` migration.

Variables (`outbox.config.ts`): OUTBOX_RELAY (`on`; `off` in tests and a worker kept for heavy queues), OUTBOX_RELAY_BATCH_SIZE (100), OUTBOX_RELAY_CONCURRENCY (10), OUTBOX_DEAD_LETTER_RETENTION_DAYS (14), OUTBOX_INBOX_RETENTION_DAYS (30).

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").

- **Metrics:** `outbox_lag_seconds` a gauge a worker reports (core/metrics): how long the longest-waiting due message has waited (the relay's `lagMs`; 0 when none). Shared state: aggregate with max().
