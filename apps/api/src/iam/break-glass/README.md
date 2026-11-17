# Break-glass

An operator (a member of the operators' tenant holding
`Platform.breakGlass`, in their own session) opens a grant to read, in an
emergency, a tenant that never invited them: `POST
/v1/tenants/:id/break-glass` (a reason of 10 to 1000 characters, at most 60
minutes, never extended, a recent sign-in), `GET` their grants, `DELETE
…/:grantId` to end one. Audited `tenant.break-glass-started` and
`…-ended` in both tenants, plus a sign-in entry (`method: break-glass`) in
the tenant; `tenancy.break-glass-started` names its administrators for the
notifications module.

BreakGlassGuard (global) checks every request carrying `Break-Glass: <grant
id>` and fails closed: not the caller's open grant, 403
`break_glass_invalid` / `break_glass_expired`; not a read, 403
`break_glass_read_only`; a valid read, 403 `break_glass_unavailable` until
core/tenancy offers a read-only tenant scope and iam/access a read-only
ability for the principal. Nothing reaches the tenant's data meanwhile.
