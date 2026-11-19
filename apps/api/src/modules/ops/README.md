# modules/ops

The operators' routes over the background work, every tenant's together:
queues and their jobs, the outbox and its dead letters, workflows. Every
route is `@OperatorOnly()` (members of OPERATOR_TENANT, or the one tenant
with TENANCY=single) on top of an `Access` action. What changes is audited
in the operators' tenant (`ops.*`).

Nothing here shows a payload: a job's or message's data may be a person's.
Failure reasons are masked as in the logs and cut.

## Routes (`/v1/ops`)

| Route                                                                         | Action                     |
| ----------------------------------------------------------------------------- | -------------------------- |
| `GET /queues` (counts by state, paused, workers)                              | `viewOps`                  |
| `GET /queues/{name}/jobs?state=&limit=` (failed by default)                   | `viewOps`                  |
| `POST /queues/{name}/pause`, `/resume`                                        | `pauseQueues`              |
| `POST /queues/{name}/retry-failed`                                            | `retryJobs`                |
| `GET /outbox` (pending, dead letters, `lagMs`: the number to alert on)        | `viewOps`                  |
| `GET /dead-letters?topic=&limit=&offset=`                                     | `viewOps`                  |
| `POST /dead-letters/retry` `{ ids? }` (all when none)                         | `retryJobs`                |
| `POST /dead-letters/discard` `{ ids? }`                                       | `discardJobs`              |
| `GET /workflows?status=&workflow=`, `GET /workflows/{id}`                     | `viewOps`                  |
| `POST /workflows/{id}/retry` (a failed one, from its journal)                 | `retryJobs`                |
| `GET /diagnostics`: the integrations, one line each                           | `viewOps`                  |
| `POST /diagnostics/{name}/test` (10 a minute per user)                        | `testIntegrations`         |
| `GET /events` (Server-Sent Events: the engines' live log)                     | `viewOps`                  |
| `POST /backlog/preview` `{ tenantId \| global, topic?, template?, before? }`  | `viewOps`                  |
| `POST /backlog/discard`, `/retry` `{ target: outbox \| mail, scope, limit? }` | `discardJobs`, `retryJobs` |

**Diagnostics.** A module declares an integration with `@Diagnostic({ name })`
on a provider that implements `DiagnosticProbe` (`check()` throws when it does
not answer; `onDemand: true` keeps the overview from running it, for a check
that does something; `testable = false` when the configuration has nothing
safe to probe). Every `@ReadinessCheck()` (the database, Redis) is listed too.
Here: `workers` and `mail` (SMTP connects and says QUIT; no mail is sent);
`modules/storage` adds `storage` (a probe file written, read and deleted). No
URL or credential is ever shown, errors are masked as in the logs.

**Events.** `GET /events` merges the live events of the workflow, webhook,
outbox, idempotency, lock, mail and resilience engines the app runs. The
schema (`ops.events.schemas.ts`) is an allowlist: no payload, header or
workflow output.

**Backlog.** The outbox keeps a message's tenant in its headers, so `tenantId`
scopes the outbox; a mail job names none, so mail is only ever `global`
(a tenant scope refuses it: 400 `mail_not_tenant_scoped`). Never discarded:
a message under a live lease, a running job, essential mail. A discarded
`notification.stored` message leaves its notification in the person's list,
never delivered by push, mail or webhook; `notifications:settle` of the CLI is
the per-person way and spares mandatory types.

Queues are found by discovery: whichever module registered one with
`BullModule.registerQueue()` appears, with no list here.

## Another module

`OpsModule` exports `OpsService` (the queue, outbox and workflow reads and
changes); the operator CLI (`src/cli`) uses it. The operator CLI also uses `OpsBacklog` and `OpsDiagnostics`. Needs QueuesModule,
SharedOutboxModule and SharedWorkflowsModule.

Remove: `pnpm module:remove ops` ([removing-a-module](../../../../../docs/removing-a-module.md)). It refuses while the CLI's queue and dead-letter commands use it.
