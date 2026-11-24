# modules/quotas

Limits per tenant, set by the operators, and the API the modules that own a limited thing call.

**Declare** a quota in the module that owns the thing, and register it in that module's imports:

```ts
export const CLIENTS = defineQuota({ key: 'apiClients', label: 'API clients', kind: 'stock',
  count: (db) => db.$count(apiClients) }); // runs in the tenant's scope
export const MAILS = defineQuota({ key: 'mail.perDay', label: 'mails a day', kind: 'rate', period: 'day' });
@Module({ imports: [QuotasModule.forFeature(CLIENTS)], … })
```

- **Stock** (what a tenant HAS): `await quotas.assertRoom(CLIENTS, adding = 1)` in the transaction that makes the
  thing, before the insert; it locks that quota's row of the tenant (`quota_locks`) until the commit, so parallel creates
  never pass the last place, while creates under other quotas (or none) don't wait. What is used is still `count()`, so a
  delete, purge or resize needs no call here. Past it: 422 `quota_exceeded`.
- **Rate** (what it USES per UTC `day` or `month`): `await quotas.consume(MAILS, amount = 1, tenantId?)`: 429
  `quota_exceeded` with `quota.resetsAt` and `Retry-After`; `tryConsume()` answers `{ allowed, used, limit, resetsAt }`
  instead of throwing. Counted in Redis, atomic across replicas, nothing taken past the limit; Redis down: allowed, logged.
- `limitOf(quota, tenantId?)` and `used(quota, tenantId?)` for views and own budgets.
- **A tenant's limit**: its own (`tenant_quotas.limits`), else its plan's, else the `default` plan's, else the
  quota's `default`, else unlimited.
- **Routes**: `GET /v1/quotas` (`Quota.read`: the tenant's use), and for operators (`@OperatorOnly()`, `Quota.setLimits`):
  `GET|PUT /v1/tenants/{id}/quotas { plan?, limits? }` (null removes a tenant limit; audited `tenant.quotas-changed` in both
  tenants), `GET /v1/quotas/plans`, `PUT|DELETE /v1/quotas/plans/{name}` (audited).

An API client's daily request quota is `modules/usage`. No variables.

Remove: `pnpm module:remove quotas` ([removing-a-module](../../../../../docs/removing-a-module.md)).

## Metrics

When a module registers a stock quota with the key `storageBytes` (attachments does), `/metrics` has `tenant_storage_bytes{tenant}` (the quota's count, per active tenant slug) and `tenant_storage_limit_bytes{tenant}` (only tenants with a limit), each tenant read in its own scope and cached for 30 seconds.
