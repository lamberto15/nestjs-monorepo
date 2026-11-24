# core/health

`GET /health/ready` (readiness; `GET /health` is the same check) and `GET /health/live` (liveness) for load balancers and orchestrators. Both are public, never rate limited, never logged, and answer while the app is in maintenance.

- **Readiness:** 200 when every readiness check answers, 503 (with the failing checks) when one does not, and for `SHUTDOWN_DRAIN_MS` after a SIGTERM, so the load balancer stops sending requests before the server closes (`TerminusModule`'s `gracefulShutdownTimeoutMs`). Each check has a 2 s timeout.
- **The worker** (`node dist/worker`, no HTTP server of its own) answers `/health/live` and `/health/ready` on `PORT` with the same checks (`worker-health.ts`), and nothing else.
- **Liveness:** 200 while the process serves requests; it asks nothing.
- **A module adds a check** by marking a provider `@ReadinessCheck('name')` and implementing `ReadinessIndicator.check()` (resolve when the dependency answers, throw when not); the controller finds it through discovery. Today: `database`, `redis`.

## Variables (`health.config.ts`)

SHUTDOWN_DRAIN_MS (5000).

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
