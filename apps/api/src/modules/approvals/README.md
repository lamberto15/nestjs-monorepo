# modules/approvals: approval workflows for record actions

An action of a record (`publish`, `markPaid`) can need approval before it runs. A feature declares the action, and a provider of its own applies it:

```ts
@Module({ imports: [ApprovalsModule.forRecord(INVOICE, { publish: { label: 'Publish an invoice' } })] })
@ApprovalEffect({ subject: 'Invoice', action: 'publish' })
class PublishInvoice implements ApprovalEffectHandler { async apply({ id, actor }) { … } }
```

- **Route:** `POST /v1/<path>/{id}/<action-path>`. Whoever may update the record asks. It answers 200 `{ status: 'applied' }` when no approval is needed (the policy is off, the flag `<camelPath>.<action>Approval` is off for the requester, or the policy's `when` does not hold), and 202 `{ status: 'pending', approvalId }` otherwise. `flag: false` always asks.
- **Lock:** while a request waits, or is approved but not yet applied, the record's update and delete answer 409 `approval_pending` (the extension's `updating`/`deleting` hooks). The effect's own writes pass. Deleting the record cancels its requests sent back for changes; purging it removes them.
- **Policy:** stages of approvers (`role`, `unitRole`, `permission`, `users`), each with a mode (`any`, `all`, `quorum`), reminders, a deadline (expire or escalate), and an optional `when` condition on the payload (`{ title }`). The default is one stage, decided by anyone who may update the record. The requester never approves their own request. Administrators (`Approval.managePolicies`) list the actions (`GET /v1/approvals/policies`, `GET /v1/approvals/policy-types`) and store versions at `PUT /v1/approvals/policies/{key}` (`DELETE` goes back to the code's default); a request keeps the copy it started with.
- **Process:** one durable workflow per request (`approval.workflow.ts`, core/workflows) starts stages, reminds, escalates, expires and runs the effect (8 attempts, then `failed`/`apply_failed`). Decisions are taken under the request's row lock and reach the workflow as signals. When a tenant is erased (`approvals.erasure.ts`), its `tenancy.tenant-erasing` handler, in the purge's transaction, publishes `approval.workflows-orphaned` (core/outbox) naming the requests whose outcome was not applied yet; after the commit a worker's consumer (`approvals.delete-orphaned-workflows`) deletes their workflow instances. A purge that rolls back keeps them; finished instances go with core/workflows' retention.
- **People:** `/v1/approvals` (inbox filters `assignedToMe`, `requestedByMe`, `decidedByMe`), `/{id}` with its timeline, `approve`, `reject`, `request-changes`, `resubmit`, `cancel`, `abandon` (with If-Match). Delegations (out of office) at `/v1/approvals/delegations`, for at most `approvals.maxDelegationDays` days (setting, default 90). A deactivated member's assignments close and their delegations end. A person's requests, decisions and delegations are in their data export (`approvals`); deleting their account keeps the requests and decisions without their name.
- **Tells:** notifications `approval.*`, realtime `approval.assigned|decided|applied`, domain events `approval.*` (core/outbox), audit entries, and the inbox source `approval`.
- **Permissions:** `Approval.read`, `cancel`, `abandon` (each may be limited to one subject) and `managePolicies`. Taking part needs none.

## Metrics

`approvals_overdue_seconds` (how far the most overdue pending stage is past its deadline) and `approvals_unapplied_seconds` (how long the oldest approved request has waited for its outcome), across every tenant, on a worker's `/metrics`. A timer reads them as the maintenance role (`Tenancy.acrossTenants()` refuses to run inside a scrape request); without DATABASE_MAINTENANCE_URL the gauges are left out. Shared state: aggregate with max().

Add-on: `pnpm feature:add --addons approvals` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `approvals.addon.js`): actions that need approval before they run (`--approvals`).
