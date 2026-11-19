# Tenants

Who a tenant is and how it lives, on top of core/tenancy (which owns the
`tenants` table, the scope and Tenancy.run).

- **Sign-up** (`POST /v1/auth/sign-up`, AUTH_SIGN_UP): an unverified account
  with a password, behind `@Captcha({ action: 'sign-up', count: 'requests' })`
  and five requests per address and email in 15 minutes. With TENANCY=single
  it joins the one tenant with SIGN_UP_ROLES; with TENANT_SIGN_UP it makes a
  tenant (its slug drawn, never chosen) and is its administrator; otherwise it
  joins no tenant. After the commit it emits `tenancy.user-signed-up`
  (iam/account listens and mails the verification link).
- **A user's tenants** (`GET /v1/auth/tenants`) and the **switch**
  (`POST /v1/auth/tenant`): the session is rotated into the chosen tenant;
  never while impersonating. Both answer during maintenance and under "SSO
  required" (`@AllowInMaintenance()`, `@WithoutSso()`).
- **Operators** (`/v1/tenants`, `@OperatorOnly()` and
  `Access.manageTenants`): list, read, create (its first administrator
  invited with `InvitationsService`, in the tenant's transaction; the mail
  after the commit),
  rename, deactivate and reactivate, delete after TENANT_DELETION_GRACE_DAYS
  (the slug typed again; a recent sign-in) and cancel. Never the operators'
  tenant, nor its slug changed (409 `operator_tenant`); no other tenant is
  made or renamed with OPERATOR_TENANT's slug, even while none has it (409
  `tenant_slug_taken`). Every change is audited in the operators' tenant and in the tenant.
- **Deactivation** ends the tenant's sessions and refresh tokens and emits
  `tenancy.tenant-deactivated` (realtime closes its sockets).
- **Nightly jobs**: TenantDeletionJob (04:30 UTC) claims a due tenant and
  SignUpSweepJob (04:15 UTC) finds sign-ups' tenants nobody verified within
  7 days; both erase through `TenantsService.purge()`: under the row's lock,
  in one transaction, it emits `tenancy.tenant-erasing` (awaited: what lives
  outside its tables; modules/storage releases the tenant's files and
  modules/approvals names its unfinished workflows, both deleted after the
  commit), deletes its row (the cascade takes its rows), audited
  `tenant.purged` in no tenant. What lingers in the background stores, and
  for how long: [iam/personal-data](../personal-data/README.md#how-long-erased-data-lingers). Its reason is `deletion`, `sign-up-unverified`
  or `moved` (a tenant moved to its own server, modules/tenant-move).
- **Freeze and restore** (for a move): `setFrozen()` makes a tenant read only
  or writable again (never the operators' own), audited `tenant.frozen` /
  `tenant.thawed` in the tenant and in no tenant; `restore()` puts back a
  tenant moved from another server with its id, refusing a slug taken.
- **Domains** (`/v1/branding/domains`, CUSTOM_DOMAINS, `Access.manageDomains`):
  a hostname proved by a TXT record `_app-verification.<hostname>`, checked
  on the queue and every night; a verified one routes its host to the tenant
  (TenantDomainsService is the `@HostTenantResolver()`).
- **Domain lock:** a provider marked `@DomainChangeGuard()` (`domain-change-guard.ts`; modules/branding) may refuse adding a domain or asking its check (409 `branding_locked`); removing is always allowed.
- **Sign-in methods:** the service is a `@SignInMethodsPart({ signUp, tenantSignUp })` of `GET /v1/auth/methods`. A sign-up's password meets the one tenant's minimum length (TENANCY=single).
- Exports `TenantsService` (the operator CLI makes tenants with it).
- Domain events (outbox): `tenant.created`, `tenant.deactivated`,
  `tenant.reactivated`, `tenant.purged`.

Tables: `tenant_lifecycle` (sign-up mark, deletion schedule),
`tenant_domains`, `tenant_domain_routes`. Variables: tenants.config.ts.
