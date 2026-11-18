# core/workflows: durable workflows

`@nestjs/workflows` on PostgreSQL (`SharedWorkflowsModule`, global). A module declares its workflow as a provider and starts it with `WorkflowClient`; steps, timers and signals live in the database and survive restarts. Steps run where the process runs workers (APP_ROLE worker or all).

- **In a tenant:** extend `TenantWorkflow` (`tenant-workflow.ts`), implement `execute()` instead of `run()`, and start it with `client.start(MyWorkflow, withTenant(input), { transaction })` from the transaction that wrote its rows: every step runs in that tenant, also after a sleep or a restart. A workflow of no tenant implements `WorkflowRunner`.
- **Schema:** `nest_workflows`, created by the `background-stores` migration (see core/outbox/README.md); the store only checks it at start.
- **Payloads are encrypted** when DATA_ENCRYPTION_KEYS is set (`workflow-payload.codec.ts`: the package's AES-256-GCM codec, keys derived from the data keys): inputs, outputs, step results, signal payloads and error messages. Keep an old key listed while a workflow started under it may still run; `keys:reencrypt` does not rewrite workflow payloads.
- Pass each step's `idempotencyKey` to its side effects: steps run at least once.

Variables (`workflows.config.ts`): WORKFLOWS_WORKER, WORKFLOW_CONCURRENCY.

Remove: delete this folder and its line in `app.module.ts`.
