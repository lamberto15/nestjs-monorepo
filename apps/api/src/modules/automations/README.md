# modules/automations

A tenant's own business rules, without code: when a record is created or
changed and a condition holds, do a few things to it. A rule is a
**trigger** (`created`, or `updated` with an optional `field`: only when that
field's value changed), a **condition** (an expression of modules/expressions
on the record, or none) and up to 5 **actions**. It runs as the user who
activated it (`owner`), with their permissions as they are at each run.

## Routes

| Route                                              | Does                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /v1/automation-rules`                         | the rules (cursor pages; `?status=`, `?subject=`, `?name.contains=`)             |
| `GET /v1/automation-rules/subjects`                | the subjects that take rules: watchable fields, condition variables, actions     |
| `POST /v1/automation-rules`                        | a draft (201, audited `automation-rule.created`)                                 |
| `GET`, `PATCH`, `DELETE /v1/automation-rules/{id}` | one rule; `automation-rule.updated`, `automation-rule.deleted` (its runs go too) |
| `POST /v1/automation-rules/simulate`               | what a definition would do now, without doing it                                 |
| `POST /v1/automation-rules/{id}/activate`          | it runs from now on, as you (`automation-rule.activated`; at most 20 active)     |
| `POST /v1/automation-rules/{id}/disable`           | it stops at once (`automation-rule.disabled`, reason `manual`)                   |
| `GET /v1/automation-rules/{id}/runs`               | the run log: what each run did, or why it failed (`?status=`, `?recordId=`)      |

Permissions: `AutomationRule.read` and `AutomationRule.configure` (everything
that changes or simulates a rule); no seed role has them. Users only, and
`configure` never while impersonating. A change of the trigger, condition or
actions is a new `version`, and an active rule becomes a draft again.

```json
{
  "name": "Escalate",
  "subject": "Invoice",
  "trigger": "updated",
  "field": "status",
  "condition": "status == 'overdue' and total > 100",
  "actions": [
    { "type": "setField", "field": "priority", "value": "high" },
    { "type": "notify", "userIds": ["…"] }
  ]
}
```

## A record that takes rules

```ts
imports: [AutomationsModule.forRecord(INVOICE)];
```

`forRecord()` adds an extension (`capability: 'automations'`) whose
`created`/`updated` hooks, in the write's transaction, publish an
`automation.due` domain event for each active rule the change triggers; the
runner (`@OnDomainEvent(automationDue)`) runs it in the worker, in the
event's tenant, as `system:automations` for its own bookkeeping. It also
declares the `<item>.automation-matched` webhook (WebhooksModule.forFeature).

## Actions: an extension point

```ts
@AutomationAction('startApproval')
@Injectable()
export class StartApprovalAction implements AutomationActionHandler<{ flowId: string }> {
  readonly params = z.object({ flowId: z.uuid() });
  async plan({ record, principal, row, params }) {
    // check as `principal`, then:
    return { allowed: true, detail: 'flow …', apply: () => this.approvals.start(…) };
  }
}
```

Any module may declare one (automations finds it with DiscoveryService);
`supports()`, `check()` (when a rule is saved) and `describe()` (in
`GET …/subjects`) are optional. Built in:

| `type`     | Does                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `setField` | `{ field, value }`: a plain field (text, number, yes/no, choice, date) through the record's store, as the owner |
| `notify`   | `{ userIds }` (at most 10): `automation.notified` to those who may read the record                              |
| `webhook`  | `{}`: `<item>.automation-matched` to the subscribed API clients that may read the record                        |
| `addTag`   | `{ tagId }` (declared by modules/tags): adds a tag of the subject, keeping the record's others                  |

## Bounds

Loops: writes made by a rule's actions trigger no rule (depth 1). At most 20
active rules per tenant, 5 actions per rule, 100 runs per rule an hour (past
it: disabled, `run_limit`), 5 failed runs in a row (`failing`), an owner no
longer an active member (`owner_inactive`), a subject no longer registered
(`subject_gone`). A refused run is kept in the log (`status: failed`,
`error` such as `notify: no_recipient`); an error that may pass is retried by
the outbox.

## Simulation

The same evaluator as a run (`check()`, `readable()`, `holds()`, `plan()`),
without `apply`: the most recently changed records you may read (or
`recordIds`), at most `limit` (≤ 50); `truncated` when the limit was reached;
`triggerSimulated: false` for a `field` trigger (no change is replayed).

Tables: `automation_rules`, `automation_runs` (tenant tables). No variables.

Add-on: `pnpm feature:add --addons automations` ([adding-a-feature](../../../../../docs/adding-a-feature.md), `automations.addon.js`): tenants' rules on a record's changes.

Remove: `pnpm module:remove automations` ([removing-a-module](../../../../../docs/removing-a-module.md)).
