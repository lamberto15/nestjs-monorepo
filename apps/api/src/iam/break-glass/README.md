# Break-glass

An operator (a member of the operators' tenant holding
`Platform.breakGlass`, in their own session) opens a grant to read, in an
emergency, a tenant that never invited them: `POST
/v1/tenants/:id/break-glass` (a reason of 10 to 1000 characters, at most 60
minutes, never extended, a recent sign-in), `GET` their grants, `DELETE
…/:grantId` to end one. Audited `tenant.break-glass-started` and
`…-ended` in both tenants, plus a sign-in entry (`method: break-glass`) in
the tenant. The domain event `tenancy.break-glass-started`
(`break-glass.events.ts`), published in the tenant, names its
administrators: modules/notifications tells them
(`security.break-glass-started`, mailed at once, mandatory).

## Reading through a grant

A request with `Break-Glass: <grant id>` reads that tenant. auth's
PrincipalGuard asks `BreakGlassService.open()` (`@BreakGlassGrantSource()`,
iam/auth/break-glass-session.ts) in the operator's own tenant, on every
request: still an operator holding `Platform.breakGlass`, the grant theirs,
open and unexpired, the tenant active and not opted out, the request a read
(GET, HEAD, OPTIONS). Then the request runs in that tenant:

- **read only in the database**: core/tenancy's read-only scope, every
  transaction `READ ONLY` (PostgreSQL refuses any write, 25006);
- **every route an administrator reads**: every action of the catalog,
  unconditional, whatever the operator's roles (iam/access), so a list
  guarded by a manage action (`manageSso`, `manageLegalHolds`…) opens too;
  only the methods above, so nothing is written;
- **told**: `user.breakGlass` (`GET /v1/auth/me` shows it), the audit
  label `<email> (break-glass)`, a `tenant.break-glass-read` entry in the
  tenant's log (method and path) and a `BreakGlass` log line.

Refusals, all 403: `break_glass_invalid` (unknown, not theirs, ended, no
signed-in operator, the permission lost), `break_glass_expired`,
`break_glass_read_only`, `break_glass_disabled`. HTTP only.

## Opt-out

The tenant's sign-in policy `allowBreakGlass: false` (iam/auth-policy,
`AuthPolicy.allowsBreakGlass()`): new grants are refused, running ones stop
at their next request.

Needs AuthModule, AccessModule, AuditModule, SharedOutboxModule. Tests:
`break-glass.e2e-spec.ts`. Remove: delete this folder and its line in
app.module.ts; a request naming a grant is then refused.
