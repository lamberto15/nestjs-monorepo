# core/workflows: durable workflows

`@nestjs/workflows` on PostgreSQL (`SharedWorkflowsModule`, global). A module declares its workflow as a provider and starts it with `WorkflowClient`; steps, timers and signals live in the database and survive restarts. Steps run where the process runs workers (APP_ROLE worker or all).

- **In a tenant:** extend `TenantWorkflow` (`tenant-workflow.ts`), implement `execute()` instead of `run()`, and start it with `client.start(MyWorkflow, withTenant(input), { transaction })` from the transaction that wrote its rows: every step runs in that tenant, also after a sleep or a restart. A workflow of no tenant implements `WorkflowRunner`.
- **Schema:** `nest_workflows`, created by the `background-stores` migration (see core/outbox/README.md); the store only checks it at start.
- **Payloads are encrypted** when DATA_ENCRYPTION_KEYS is set (`workflow-payload.codec.ts`: the package's AES-256-GCM codec, keys derived from the data keys): inputs, outputs, step results, signal payloads and error messages. Keep an old key listed while a workflow started under it may still run; `keys:reencrypt` does not rewrite workflow payloads.
- Pass each step's `idempotencyKey` to its side effects: steps run at least once.
- **Retention:** `WorkflowsRetentionJob` (04:25 UTC, one instance) deletes instances that finished (completed, failed, cancelled) more than WORKFLOWS_RETENTION_DAYS ago, with their journals, the signals no unfinished instance can take and the ended rate-limit windows (`WorkflowClient.purge()`). Unfinished and `compensation_failed` instances stay. A signal's `id` deduplicates only until it is purged: keep the days longer than any sender's redelivery window and longest transaction (the app's signals are sent in the transaction of their change).
- A module whose instances can never finish (their rows erased) deletes them itself: `delete(id, { force: true })` (modules/approvals, at a tenant's erase).

Variables (`workflows.config.ts`): WORKFLOWS_WORKER (`on`; `off` in a worker kept for heavy queues and in tests), WORKFLOW_CONCURRENCY (10), WORKFLOWS_RETENTION_DAYS (14).

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
