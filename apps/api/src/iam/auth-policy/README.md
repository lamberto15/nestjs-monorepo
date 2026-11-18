# iam/auth-policy

A tenant's sign-in policy, stored in `auth_policies` (one row per tenant,
global with the tenant named: read before a request has a tenant) and
applied by iam/auth as the `@AuthPolicySource()`, always under the
deployment's environment, which stays the ceiling.

| Field                                   | Applied where                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `requireMfa`                            | MfaEnrollmentGuard: 403 `mfa_enrollment_required` until enrolled (never with AUTH_MFA off)   |
| `passwordMinLength`                     | a password change, a reset or invitation link (iam/account); 12 to 64                        |
| `passwordHistory`                       | with PASSWORD_HISTORY, the stricter (iam/account)                                            |
| `sessionIdleMinutes`, `sessionMaxHours` | SessionLifetime: sessions and token families, under SESSION_IDLE_MINUTES / SESSION_MAX_HOURS |
| `allowBreakGlass`                       | `AuthPolicy.allowsBreakGlass()`, for iam/break-glass                                         |

A person in several tenants meets the strictest password rules.

## Two-factor at three scopes

`requireMfa` is required of a member when any of these holds: the
**platform** (the operators' value, `auth_policy_platform`, for every
tenant: a tenant can't go below it), their **tenant**, or one of their
**units**, or a unit above it (`auth_policy_units`: a unit's rule reaches the
units under it). The writer of any scope that covers them needs two-factor
themselves (409 `mfa_enroll_first`); with AUTH_MFA off none can be set.

## Routes

- `GET /v1/access/auth-policy` (`Access.readAuthPolicy`)
- `PATCH /v1/access/auth-policy` (`Access.updateAuthPolicy`, a recent
  sign-in): 400 `setting_not_allowed` over the ceiling, 409
  `mfa_enroll_first` when requiring two-factor would lock the caller out.
  Audited `auth-policy.updated`.
- `GET|PUT /v1/access/auth-policy/units/{unitId}` (`Access.readAuthPolicy` /
  `updateAuthPolicy`, a recent sign-in for PUT): `{ requireMfa }`; `false`
  removes the unit's own rule. Audited `auth-policy.unit-updated`.
- `GET|PUT /v1/access/auth-policy/platform` (`@OperatorOnly()` and
  `Access.managePlatformAuthPolicy`, a recent sign-in for PUT): `{ requireMfa }`.
  Audited `auth-policy.platform-updated`.

Remove: delete this folder and its line in app.module.ts; the
environment's limits then apply alone.
