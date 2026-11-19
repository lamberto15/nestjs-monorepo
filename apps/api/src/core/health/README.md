# core/health

`GET /health` (readiness) and `GET /health/live` (liveness) for load balancers and orchestrators. Both are public, never rate limited, never logged, and answer while the app is in maintenance.

- **Readiness:** 200 when every readiness check answers, 503 (with the failing checks) when one does not or while the app shuts down. Each check has a 2 s timeout.
- **Liveness:** 200 while the process serves requests; it asks nothing.
- **A module adds a check** by marking a provider `@ReadinessCheck('name')` and implementing `ReadinessIndicator.check()` (resolve when the dependency answers, throw when not); the controller finds it through discovery. Today: `database`, `redis`.

No variables.

Remove: delete this folder and its line in `app.module.ts` (the checks of other modules then have no endpoint).
