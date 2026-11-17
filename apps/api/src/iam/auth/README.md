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
  `sessionMaxHours` (only shorter than the environment's).
- `@HostTenantResolver()`: `tenantOfHost(host)` for tenants' own domains.
- `@ReauthenticationMethods()`: more ways back for a 403
  `reauthentication_required` (passkeys, MFA).
- `@AuthenticationOptionsPart(ctx => options)`: a slice of
  @nestjs/authentication's options (a duplicate key fails the boot).

At most one provider each for the policy and host resolvers (two fail the
boot). None means the environment's limits, no tenant domains.

## Guard order

Throttling, then `PrincipalGuard` (authenticates, refuses the system
principal, enters the user's tenant), `MfaEnrollmentGuard`,
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
