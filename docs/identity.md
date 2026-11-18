# Identity and access

The concepts behind `apps/api/src/iam`, and which module owns each. A module
README has the routes, variables and extension points; this page says how the
pieces fit.

## Account, membership, unit membership

- **Account** (`users`, [iam/auth](../apps/api/src/iam/auth/README.md)): one per email address,
  whatever tenants it belongs to. It holds the name, the password hash, the
  language and time zone, and whether the address is verified. Only its owner
  changes it.
- **Membership** (`memberships`): an account's place in one tenant, active or
  not. It is what lets the account act in that tenant. Roles are granted to a
  membership, in the tenant.
- **Unit membership** (`organizational_unit_memberships`,
  [iam/organization](../apps/api/src/iam/organization/README.md)): a membership's place in an
  organizational unit, as member or lead, with dates. Ended ones are kept as
  history.

Deactivating a membership removes access to one tenant; deactivating the
account removes it everywhere.

## Tenants

A tenant is a customer: its rows are seen and written only in its scope. The
wall is [core/tenancy](../apps/api/src/core/tenancy/README.md) (row-level security today);
modules never know how it is built and ask it for the tenant's database.
`TENANCY=multi|single` picks many tenants or one.

[iam/tenants](../apps/api/src/iam/tenants/README.md) owns the life of a tenant: sign-up,
`GET /v1/auth/tenants` and `POST /v1/auth/tenant` (the switch), the
operators' routes under `/v1/tenants`, deactivation, deletion after a grace
period, and a tenant's own domains (`/v1/branding/domains`).

**The operators' tenant** is the one named by `OPERATOR_TENANT`. Its members
are the operators of the deployment: `@OperatorOnly()` routes need one.
With `TENANCY=multi` and no `OPERATOR_TENANT`, nobody is an operator.

## Sign-in methods

All are in [iam/auth](../apps/api/src/iam/auth/README.md) (the session and the principal) and
[iam/account](../apps/api/src/iam/account/README.md) (the methods), under `/v1/auth`.
`GET /v1/auth/methods` tells a page which are on.

- **Password:** `POST /v1/auth/sign-in`; the password routes are under
  `/v1/auth/password`, email verification under `/v1/auth/email`.
- **Passkeys:** `/v1/auth/passkeys`.
- **Magic links:** `/v1/auth/magic-link`.
- **Providers:** OpenID Connect and OAuth sign-in (Google, GitHub:
  `/v1/auth/oidc/:provider/login`), and linked identities under
  `/v1/auth/identities`.
- **Enterprise single sign-on:** a tenant's own OIDC, OAuth and SAML
  connections, verified email domains and "SSO required":
  [iam/sso](../apps/api/src/iam/sso/README.md), `/v1/sso` and `/v1/auth/sso`.
- **Two-factor (MFA):** `/v1/auth/mfa`: enrol, confirm, recovery codes,
  verify. A tenant or unit can require it (see auth policy below).
- **Re-authentication:** a sensitive route asks for a recent sign-in
  (`@RecentAuthentication()`); `/v1/auth/reauthenticate` is the way back.

A public sign-in route can be protected from bots (see Bot protection).

## Sessions and tokens

A browser gets a session cookie. A mobile app or a CLI gets a short-lived JWT
access token and a single-use refresh token (`/v1/auth/token`: exchange,
refresh, revoke). `GET /v1/auth/sessions` lists a person's sessions,
`DELETE /v1/auth/sessions/:id` ends one and
`POST /v1/auth/sign-out-everywhere` ends all. Idle and maximum lifetimes
come from the environment and can only be shortened per tenant. Request
credentials are described in [API conventions](api-conventions.md#credentials).

## API clients and keys

A system that calls the API is an **API client**: a tenant's, with roles and
an optional address allowlist, managed at `/v1/access/clients`
([iam/api-clients](../apps/api/src/iam/api-clients/README.md)). A client holds one or more keys
(`sk_<id>_<secret>`), shown once, with rotation and a grace period. The
`API_CLIENTS` switch turns the routes off. What lets a key in is
[iam/auth](../apps/api/src/iam/auth/README.md).

## Roles, permissions, conditions, field permissions

[iam/access](../apps/api/src/iam/access/README.md), under `/v1/access` (`catalog`, `roles`,
`users`, `principals`).

- A **permission** is an action on a subject (`Note.update`), with optional
  **conditions** and optional **fields**.
- A **condition** (`mine`, `inMyUnits`, ...) is written once as
  column/value data. It checks one record and also becomes the SQL filter of a
  list, so the two cannot disagree.
- **Field permissions** hide or protect fields (`sensitive`): the answer is
  redacted, and a list refuses a filter or sort on a field the caller may not
  read.
- A **role** is a set of permissions administrators edit, granted to
  memberships and API clients. You may grant only what you hold.
- A module declares its permissions next to its code (`definePermissions`)
  and registers them with `AccessModule.forFeature()`; routes use `@Can()`.
  Permission texts come from the module's `i18n` files.

CASL runs inside `access.service.ts` only. Jobs run as a system principal
with just the permissions their `defineSystemJob()` declares.

## Organizational units

A tenant's tree of divisions, departments and teams, with dated memberships:
[iam/organization](../apps/api/src/iam/organization/README.md), `/v1/access/organizational-units`.
The unit conditions (`inMyUnits`, `inMyUnitsAndBelow`,
`inUnitsILeadAndBelow`) let a permission apply to records of the caller's
units. Units the identity provider manages through SCIM cannot be changed by
hand. [modules/people](../apps/api/src/modules/people/README.md) lists people and units for
pickers.

## Invitations

An administrator invites an address or prepares a member, with roles and
units; the person accepts with a one-time link:
[iam/invitations](../apps/api/src/iam/invitations/README.md), `/v1/access/users` and
`/v1/access/invitations`, `POST /v1/auth/invitations/accept`. Inviting
reveals nothing about existing accounts.

## SCIM

A tenant's identity provider can provision users and groups over SCIM 2.0 at
`/v1/scim`, with an API client key holding `Access.provisionScim`. SCIM
users are deactivated, never deleted. It lives in
[iam/sso](../apps/api/src/iam/sso/README.md).

## Impersonation and break-glass

- **Impersonation:** an administrator acts as a member for support
  (`IMPERSONATION=on`, a recent sign-in, never an administrator, never
  across tenants): [iam/impersonation](../apps/api/src/iam/impersonation/README.md),
  `POST /v1/access/users/:id/impersonate`.
- **Break-glass:** an operator opens a time-limited, read-only grant to a
  tenant that never invited them, with a reason:
  [iam/break-glass](../apps/api/src/iam/break-glass/README.md), `/v1/tenants/:id/break-glass`.
  A request then names it in the `Break-Glass` header. A tenant can opt out.

Both are audited, and the tenant's administrators are told of a break-glass.

## Auth policy scopes

[iam/auth-policy](../apps/api/src/iam/auth-policy/README.md), `/v1/access/auth-policy`: a
tenant's minimum password length and history, session lifetimes, whether
break-glass is allowed, and two-factor. Two-factor can be required at three
scopes: the platform (operators set it for every tenant), the tenant, and an
organizational unit (it reaches the units below). The environment is always
the ceiling: a tenant can be stricter, never looser.

## Audit

[iam/audit](../apps/api/src/iam/audit/README.md) writes the log: who did what, in which tenant
(`AuditService.record()`). [iam/audit-log](../apps/api/src/iam/audit-log/README.md) serves it:
`GET /v1/access/audit` and `GET /v1/access/sign-ins`, for whoever has
`Access.readAudit`. A daily job removes entries older than
`AUDIT_RETENTION_DAYS`.

## Legal holds

[iam/holds](../apps/api/src/iam/holds/README.md), `/v1/legal-holds`: a hold keeps a record (or
every record of a subject) from deletion, retention rules and purges until it
is released. A module that deletes a record calls
`LegalHoldsService.assertNotHeld()`.

## Personal data export and account deletion

[iam/personal-data](../apps/api/src/iam/personal-data/README.md), `/v1/account`: a person's
deletion request (a grace period, then a nightly job anonymises the
account), and consents. A module that holds data about a person marks a
provider `@PersonalData()`, and the deletion and the copy both walk those
sections. The copy itself is requested at `POST /v1/account/export`
([modules/data-transfer](../apps/api/src/modules/data-transfer/README.md)).

## Bot protection

[iam/captcha](../apps/api/src/iam/captcha/README.md): a public route takes `@Captcha()`, and
the guard asks for a token (Cloudflare Turnstile) always or after repeated
failures. Native apps use app attestation instead. `GET /v1/auth/captcha`
tells a page whether to show it.
