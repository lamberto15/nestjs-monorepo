# core/throttling

Rate limiting (`@nestjs/throttler`) on every route: `RATE_LIMIT_PER_IP` (1200) requests a minute per IP (the address the HTTP adapter resolved behind the trusted proxies), counted in Redis so the limit holds across instances. Over it: 429 `rate_limited` with `Retry-After`, as problem details.

- **A route tightens it** with `@Throttle({ default: { limit, ttl } })` and skips it with `@SkipThrottle()` (health does).
- **The limit per signed-in caller** (`RATE_LIMIT_PER_CALLER`, 600 a minute per user or API client, on every route) is iam/auth's `UserThrottlerGuard`, which runs after authentication; a route changes it with `@UserThrottle()`. Sign-in style limits per group and caller are `@AddressThrottle()`. Both build on `ScaledThrottlerGuard` here.
- **RATE_LIMIT_MULTIPLIER** multiplies every limit (the global one, each `@Throttle()`, the iam ones). For the load test's stack only, whose requests all come from one address: with NODE_ENV=production a value above 1 stops the app unless APP_ENV=loadtest.

Variables (`throttling.config.ts`): RATE_LIMIT_STORE (`redis` default, or `memory` for one instance and tests), RATE_LIMIT_MULTIPLIER (1), NODE_ENV, APP_ENV.

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
