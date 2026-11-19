# Background work

Work that must not run inside a request: queued jobs, scheduled jobs, domain
events and long processes. Each piece is a module in `apps/api/src/core`;
a feature module uses them by declaring its own code next to its own folder.
Nothing is registered in a central file.

## Processes

The same app runs in three shapes, chosen by `APP_ROLE`
([core/queues](../apps/api/src/core/queues/README.md)):

- `api`: serves HTTP; runs no queue processors, scheduled jobs, outbox relay
  or workflow steps.
- `worker`: runs all of those, with no HTTP server (`node dist/worker`).
- `all`: both in one process (the default, for development and small
  deployments).

Producers (adding a job, publishing an event) work in every process.
Consumers run only where workers run. `WORKER_QUEUES` and
`WORKER_QUEUES_EXCLUDE` split queues between workers so a heavy queue can
have a worker of its own. See [Deployment](deployment.md).

## Queues

`QueuesModule` holds the BullMQ connection (Redis) and the default job
options (`DEFAULT_JOB_OPTIONS`). A module registers its own queue, adds to it
and consumes it:

- `BullModule.registerQueue({ name })` in the module, and `@InjectQueue(name)`
  to add.
- `@Processor(name)` on the consumer.

A job for one tenant carries its tenant: add it with `withTenant(data)` and
consume it with `TenantWorkerHost` (`handle()` runs in the job's tenant,
[core/tenancy](../apps/api/src/core/tenancy/README.md)). The smallest real example is
`apps/api/src/modules/recurrence`: `recurrence.service.ts` adds the job with
`withTenant({})`, `recurrence.processor.ts` consumes it, and
`recurrence.module.ts` registers the queue.

A long job a person asked for (an export, an import, a bulk run) is listed
for them by `JobIndex` ([core/jobs](../apps/api/src/core/jobs/README.md)). An add
refused while Redis is down is a 503 (`queueUnavailable()`).
`QUEUE_CONCURRENCY_<QUEUE>` sets one queue's concurrency. The operators see
and manage queues at `/v1/ops/queues` (pause, resume, retry failed;
[modules/ops](../apps/api/src/modules/ops/README.md)), and with `pnpm ops queue:list`.

## Scheduled jobs and locks

A scheduled job is a method with `@Cron()` (`@nestjs/schedule`) and
`@OnOneInstance({ key })` (`@nestjs/locks`): every instance has the
schedule, one runs each tick. Add `@WithoutOverlapping()` so a slow run is not
started again. Locks live in PostgreSQL (the `locks` table), on the database's
clock ([core/locks](../apps/api/src/core/locks/README.md)).

Jobs fire only in a process that runs workers and with `SCHEDULER` on.
`SchedulerRegistry` exists everywhere. A restricted app mode pauses them
([modules/mode](../apps/api/src/modules/mode/README.md)).

The scheduled method should do little: queue the work, one job per tenant.
Smallest example: `apps/api/src/modules/recurrence/recurrence.scheduler.ts`
(every five minutes, queues the due tenants). For a lock of your own, inject
the `@nestjs/locks` service and take a lock by key.

## The outbox and domain events

A domain event tells other modules that something happened, without importing
them. Dependencies point one way (`core` ← `iam` ← `modules`), so a module
that would otherwise close a cycle publishes an event instead
([core/outbox](../apps/api/src/core/outbox/README.md)).

- **Define** the event where its module owns it, with no central list:
  `defineEvent<Payload>('note.published')` (`core/outbox/events.ts`).
- **Publish** in the transaction of the change:
  `await this.events.publish(event, payload, { key })` inside a
  `@Transactional()` method. Outside a transaction it throws. The event is
  written with the change, so it is delivered if and only if the change
  commits. Events with the same `key` are delivered one at a time, in order.
  An event nothing subscribes to is not stored.
- **Subscribe** in any module, on a provider's method:
  `@OnDomainEvent(event, { consumer: 'search-index' })`. It runs in the worker,
  in the tenant the event was published in, within about a second of the
  commit, once per consumer name (the inbox). Keep the consumer name stable.
- **Retries and dead letters.** A handler that throws is retried with backoff
  (10 seconds to minutes), then dead-lettered. A `NonRetryableMessageError`
  dead-letters at once. Operators list, retry and discard dead letters at
  `/v1/ops/dead-letters` or with `pnpm ops dead-letter:list`. `GET /v1/ops/outbox`
  reports `lagMs`, the number to alert on; the same value is the metric
  `outbox_lag_seconds`.
- **Writes in a handler:** use `ctx.processInTransaction(tx, work)` so its
  effects happen once.
- A nightly job removes old dead letters and inbox records
  (`OUTBOX_DEAD_LETTER_RETENTION_DAYS`, `OUTBOX_INBOX_RETENTION_DAYS`).

Examples: `apps/api/src/modules/merge/merge.events.ts` defines events, and
`apps/api/src/modules/webhooks/webhooks.security.ts` subscribes to one that
`iam/api-clients` publishes. Realtime pushes from an event the same way
([modules/realtime](../apps/api/src/modules/realtime/README.md)).

The outbox and workflow tables (`nest_outbox`, `nest_workflows`) are created
by the `background-stores` migration, run as the database owner, because the
app's role may not create tables.

## Workflows

A workflow is a long process with steps, timers and signals whose state is in
PostgreSQL, so it survives restarts
([core/workflows](../apps/api/src/core/workflows/README.md)). A module declares one as
a provider with `@Workflow('name')`, extends `TenantWorkflow` (implement
`execute()`) so each step runs in the tenant that started it, and starts it
with `WorkflowClient.start(MyWorkflow, withTenant(input), { transaction })`
from the transaction that wrote its rows.

- Steps run at least once: pass each step's `idempotencyKey` to its side
  effects.
- Inputs, outputs, step results, signal payloads and error messages are
  encrypted when `DATA_ENCRYPTION_KEYS` is set. Keep an old key listed while a
  workflow started under it may still run: `keys:reencrypt` does not rewrite
  workflow payloads.
- `WORKFLOWS_WORKER=off` keeps a worker from running steps. Operators see and
  retry workflows at `/v1/ops/workflows`.
- A nightly job removes finished instances (`WORKFLOWS_RETENTION_DAYS`). How
  long an erased tenant's or account's data stays in workflows, queues and
  dead letters:
  [iam/personal-data](../apps/api/src/iam/personal-data/README.md#how-long-erased-data-lingers).

Example: `apps/api/src/modules/approvals/approval.workflow.ts`, started in
`approvals.service.ts`.

## Mail

Mail goes through a queue: the request renders it, a worker sends it, with
retries over hours (10 attempts, exponential backoff)
([core/mail](../apps/api/src/core/mail/README.md)).

- **Transport:** `MAIL_TRANSPORT` is `file` (the default: `.eml` files in
  `MAIL_DIRECTORY`), `log`, `smtp` (`SMTP_URL`), `resend`, `postmark`,
  `sendgrid` (`MAIL_API_KEY`), `ses` (AWS credentials) or `memory` (tests).
- **A mail is a class** in the module's folder that implements `Mailable`:
  `render(data, { locale })` returns the subject (from the module's `i18n`
  catalog) and a template name with its context. The HTML (and optional text)
  templates live in the module's `templates/` folder and are wrapped in the
  shared layout. Template names are global: prefix them with the module.
  Smallest example: `apps/api/src/modules/shares/shares.mail.ts`, sent in
  `shares.service.ts` with `mailQueue.send(ShareCodeMail, { to, data, locale }, { jobId })`.
- **`@EssentialMail()`** marks mail that must still go out when delivery is
  limited to essential mail (sign-in links, security alerts).
- **Delivery policy.** `MAIL_DELIVERY` is `all`, `essential` or `off`: the
  ceiling. A withheld mail is logged and counted (`mail_withheld_total`), not
  queued. [modules/deliverability](../apps/api/src/modules/deliverability/README.md)
  marks providers with `@MailDeliveryPolicy()` (a stricter mode, and a
  tenant's daily budget) and `@MailSuppressionList()` (addresses the worker
  must not send to, from bounces and complaints). Core never imports them: it
  finds them by discovery, and sends to everyone when they are absent.
- **Branding.** [modules/branding](../apps/api/src/modules/branding/README.md) marks
  `@MailBrand()`, so templates read `{{ brand.name }}`, the colour and the logo
  of the tenant.
- Operators count the mail backlog with `pnpm ops backlog:count --global`,
  and discard or retry it with `pnpm ops backlog:discard mail --global` or
  `backlog:retry mail --global`.

## Adding to a module

| To do this         | Do this                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| Run work later     | register a queue; add with `withTenant()`; a `TenantWorkerHost` consumer        |
| Run on a schedule  | `@Cron()` + `@OnOneInstance({ key })` + `@WithoutOverlapping()`; queue the work |
| Tell other modules | `defineEvent()`; `events.publish()` in the transaction; `@OnDomainEvent()`      |
| Run a long process | a `TenantWorkflow` with `@Workflow()`; start it with `WorkflowClient`           |
| Send an email      | a `Mailable` class, a template, `mailQueue.send()`                              |
