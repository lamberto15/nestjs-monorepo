# iam/auth

Who is calling. Sign-in with a password, the session cookie, access tokens
(JWT) and API keys, built on @nestjs/authentication. Every request gets one
principal (`principal.ts`): a user, an API client, or none; the system
principal is for jobs only and the guard refuses it on a request.

## In a module

- **Routes need credentials by default.** `@Public()` opens one.
  `@CurrentUser() user: RequestPrincipal` reads the principal (the
  signed-in user's `tenantId` is already the request's tenant).
- **Narrow a route:** `@UserOnly()`, `@ClientOnly()`,
  `@RecentAuthentication({ maxAgeMinutes? })` (403
  `reauthentication_required`), `@OperatorOnly()` (members of the
  operators' tenant), `@RequiresSwitch('auth.impersonation',
'IMPERSONATION')` (404 `feature_off`), `@UserThrottle()`,
  `@AddressThrottle()`, `@DuringOnboarding()`, `@DuringMfaEnrollment()`.
- **Tests:** `test/auth.ts`: `authModules()`, `createUser`, `signIn`,
  `signedInUser`, `accessTokenFor`, `apiClient`.

```ts
const app = await bootModules(...authModules(), NotesModule);
const { headers } = await signedInUser(app);
await app.inject({ method: 'GET', url: '/v1/notes', headers });
```

## Extending it (no registry, no forRoot options)

Events (`auth.events.ts`, @nestjs/event-emitter, `emitAsync`):
`auth.signed-in`, `auth.sign-in-failed`, `auth.session-ended`,
`auth.token-session-ended`, `auth.client-ip-denied`. iam/audit listens;
auth never imports it.

Discovery decorators (DiscoveryService, put on one provider of yours):

- `@AuthPolicySource()`: a tenant's `requireMfa`, `sessionIdleMinutes`,
  `sessionMaxHours` (only shorter than the environment's),
  `passwordMinLength`, `passwordHistory` and `allowsBreakGlass`
  (iam/auth-policy). `AuthPolicy.assertPasswordLength(password, path,
owner)` is the 400 `password_too_short` every route that sets a
  password calls.
- `@WhoAmIPart({ avatarUrl: z.string().nullable() })` (`who-am-i.ts`):
  keys, with their Zod schemas, a provider's `whoAmI({ user, session })`
  adds to `GET /v1/auth/me`; `@SignInMethodsPart({ signUp: z.boolean() })`:
  keys its `signInMethods()` adds to `GET /v1/auth/methods`. A key declared
  twice fails the boot. The OpenAPI document types both answers from the
  parts' schemas (`declaredShape()`, core/http/openapi.ts).
- `@HostTenantResolver()`: `tenantOfHost(host)` for tenants' own domains.
- `@ImpersonationRules()` (`impersonation.ts`): `mayImpersonate(actor,
target)`, who may act as whom (iam/impersonation). SessionAuth asks it, in
  the impersonation's tenant, on every request of a running one; without
  one, an impersonation session is refused.
- `@BreakGlassGrantSource()` (`break-glass-session.ts`): `open(user,
grantId, request)` checks a request naming a grant (`Break-Glass`
  header, iam/break-glass); PrincipalGuard then enters the grant's tenant
  read only and sets `user.breakGlass`. Without one, the header is a 403
  `break_glass_invalid`.
- `@ReauthenticationMethods()`: more ways back for a 403
  `reauthentication_required` (passkeys, MFA).
- `@AuthenticationOptionsPart(ctx => options)`: a slice of
  @nestjs/authentication's options (a duplicate key fails the boot).

- `@SignInGate()` (`sign-in-gate.ts`): a tenant's say in a password or
  passkey sign-in, `signInTenant(user, method)` and
  `assertSignInTenant(user, tenantId, method)` (iam/sso's "SSO required":
  403 `sso_required`). Password sign-in here and account's token, passkey
  and native sign-ins ask it through `SignInGates`. `@WithoutSso()` marks
  the routes a session refused by "SSO required" still reaches (sign-out,
  the tenants list and switch, an invitation's acceptance, signing out
  everywhere); the module that enforces the rule reads it.

At most one provider each for the policy, host resolver, sign-in gate,
break-glass grants and impersonation rules (two fail the boot). None means the environment's limits, no tenant
domains, and sign-ins in the last chosen tenant.

## Routes

`POST /v1/auth/sign-in`, `POST /v1/auth/sign-out`; `GET /v1/auth/me`
(the user, the tenant, `mfaEnrollmentRequired`, `onboardingRequired`, the
session's lifetime, then the parts: iam/account adds `mfaEnabled`,
`hasPassword`, `authentication`, `can`), reachable during MFA enrollment,
onboarding, maintenance and "SSO required"; `GET /v1/auth/methods`
(public: `password`, then the parts).

## Guard order

Throttling, then `PrincipalGuard` (authenticates, refuses the system
principal, enters the user's tenant, or a break-glass grant's read only), `MfaEnrollmentGuard`,
`OnboardingGuard`, then authorization: each needs the principal before it.

## Variables

`auth.config.ts`: `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`,
`SESSION_COOKIE_SECURE`, `JWT_SECRET` (unset: a key kept in core/secrets),
`API_CLIENTS`, `IMPERSONATION`, `REAUTHENTICATION_MAX_AGE_MINUTES`,
`OPERATOR_TENANT` (the operators' tenant slug; unset with TENANCY=multi
means nobody is an operator).

## Tests

Unit specs next to the code; `auth.e2e-spec.ts`,
`drizzle-authentication.store.e2e-spec.ts` (the package's store contract),
`single-tenant.e2e-spec.ts`.
