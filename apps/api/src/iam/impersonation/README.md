# Impersonation

An administrator acts as a member, for support (IMPERSONATION=on,
`Access.impersonate`, a recent sign-in, a session): `POST
/v1/access/users/:id/impersonate` replaces their session with one of the
member's that records the impersonator; `POST /v1/auth/impersonation/stop`
gives them their own back, in the tenant it began in.

Never oneself, never nested, never an administrator, never across tenants,
never someone holding what the administrator couldn't grant. The session ends
after IMPERSONATION_TTL_MINUTES; SessionAuth (iam/auth) checks it on every
request, and asks this module's rule again each time
(`ImpersonationService.assertEligible()`, the `@ImpersonationRules()`): once
the administrator loses `Access.impersonate` or the member gains the
Administrator role or anything the administrator couldn't grant, the next
request is a 401. An impersonation is never a recent sign-in, so sensitive routes
refuse it. Audited `user.impersonation-started` and `…-stopped`.
