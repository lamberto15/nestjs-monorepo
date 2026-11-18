# Deployment

What a deployment needs. The repository builds an image and describes what
that image requires; the platform around it (an orchestrator, a proxy, backups,
monitoring) is the host's, and is not here. CI builds and scans the image,
`publish.yml` publishes the one CI passed, and nothing deploys it
([CI and the image](ci.md)).

## The image

`docker build -t app .` at the root builds the API and the web app into one
image, which runs as the unprivileged `node` user. One image, three commands:

```bash
docker run app                    # node dist/main: the HTTP API (default)
docker run app node dist/worker   # the queue and schedule worker
docker run app node dist/migrate  # the migrations, once per deploy
```

The web app is built into `/app/web` (`WEB_ROOT`) and served by the API from
its own origin: one image, one origin
([core/web](../apps/api/src/core/web/README.md)). `/app/.data` is the only
writable path (local files and the mail directory); mount a volume on it or
use S3 and an SMTP or mail API instead. The image's `HEALTHCHECK` calls
`/health/live`. A `worker` container serves no HTTP, so turn the health check
off for it. Set `SECURITY_CONTACT` to publish `/.well-known/security.txt`. A
static page while the app is down (a deploy, an outage) is the host's: the
load balancer or proxy in front serves it; `APP_MODE=maintenance` covers a
running app.

Set `GIT_SHA` (the release the observability backends report) and
`SERVICE_NAME` when you run it.

## Services

- **PostgreSQL 18 or later.** Development uses `postgres:18.6-alpine` from
  `compose.dev.yaml` (`pnpm services:up`).
- **Redis 7 or later.** Development uses `redis:8.10.3-alpine`. It holds the
  queues, rate limits, locks, caches and the realtime fan-out
  ([core/redis](../apps/api/src/core/redis/README.md)). `rediss://` turns TLS
  on, and `REDIS_SENTINELS` switches to Sentinel.
- **Files:** `STORAGE_DRIVER=local` writes under `/app/.data`; `s3` uses a
  bucket ([modules/storage](../apps/api/src/modules/storage/README.md)).
- **Mail:** `MAIL_TRANSPORT` defaults to `file`, which writes `.eml` files.
  A deployment sets `smtp` or a provider
  ([core/mail](../apps/api/src/core/mail/README.md)).
- **Gotenberg, optional.** A record's PDF is rendered by a Gotenberg
  container you run (`GOTENBERG_URL`; without it documents are off and
  everything else works). Its flags and network rules are in
  [modules/documents](../apps/api/src/modules/documents/README.md).

## Database roles and migrations

Three roles on one database
([core/database](../apps/api/src/core/database/README.md), "Roles"):

| Variable                   | Role                                                | Used by            |
| -------------------------- | --------------------------------------------------- | ------------------ |
| `DATABASE_URL`             | the app's: no superuser, no BYPASSRLS, owns nothing | API and worker     |
| `DATABASE_OWNER_URL`       | the owner: runs migrations, makes the other roles   | the migration only |
| `DATABASE_MAINTENANCE_URL` | BYPASSRLS, for work across every tenant             | workers only       |

The migration makes the app role from its URL if it is missing. A superuser or
BYPASSRLS app role is refused at start. Only a superuser can create the
maintenance role: elsewhere make it once by hand, as the error says. Outside
production the owner and maintenance URLs default to the development
database's; in production they have no default.

**Migrations.** `MIGRATE_ON_START` defaults to on outside production and off
in production. In production run `node dist/migrate` once per deploy, before
the new release starts. It takes an advisory lock, so a second run waits and
finds nothing to do. It needs `DATABASE_OWNER_URL` and `DATABASE_URL` (and
`DATABASE_MAINTENANCE_URL` for the maintenance role). Write migrations so the
previous release keeps working while they run.

## What a production start needs

Set `NODE_ENV=production` (the image does). It turns off migrations at start,
makes logs JSON, keeps the strict browser headers, and falls back on missing
texts. A wrong value stops the start and names every variable at fault, never
its value ([core/config](../apps/api/src/core/config/README.md)). The full list
is [`apps/api/env.example`](../apps/api/env.example), generated from the
modules' `*.config.ts` files.

The ones a production deployment sets:

- `DATABASE_URL` (required), `DATABASE_OWNER_URL` for the migration,
  `DATABASE_MAINTENANCE_URL` for workers.
- `REDIS_URL`: it defaults to a local Redis, which a deployment replaces.
- `APP_URL` (the public origin) and, when the web app is elsewhere,
  `WEB_URL`: mail links and sign-in redirects use them
  ([core/http](../apps/api/src/core/http/README.md)).
- `DATA_ENCRYPTION_KEYS` and `BLIND_INDEX_KEYS`: the app refuses to start when
  a module declares an encrypted column and the keys are missing, and a key
  shorter than 32 characters is refused ([core/encryption](../apps/api/src/core/encryption/README.md)).
  Both are secrets: `DATA_ENCRYPTION_KEYS_FILE` and `BLIND_INDEX_KEYS_FILE`
  take them from files (below).
- `MAIL_TRANSPORT` and its credentials; `STORAGE_DRIVER` with the bucket.
- `APP_ROLE` per process (below).

Refused in production:

- `RATE_LIMIT_MULTIPLIER` above 1, and `CAPTCHA_PROVIDER=stub`, unless
  `APP_ENV=loadtest`.
- Passkeys with an RP ID of `localhost` or an address, or with origins that
  are not `https` (set `PASSKEY_RP_ID` and `PASSKEY_ORIGINS`, or `WEB_URL`).
  The RP ID cannot change once a credential exists.

Never in production, by their descriptions: `SSO_ALLOW_LOOPBACK`, the
webhooks' loopback switch and `APP_ATTEST_DEVELOPMENT`.

**Secrets as files.** A variable declared with `secret()` also takes
`<NAME>_FILE`, the path of a file holding the value (a Docker or Kubernetes
secret). Giving both is an error. `env.example` marks each such variable.
The logger masks them.

## Health, metrics, observability

- `GET /health` is readiness: 200 when the database, its pool and Redis
  answer, 503 when one does not and while the app shuts down.
  `GET /health/live` is liveness and asks nothing. Both are public, never
  rate limited and answer in maintenance
  ([core/health](../apps/api/src/core/health/README.md)).
- `GET /metrics` is Prometheus text. With `METRICS_TOKEN` unset it answers 404;
  set it (16 characters or more) and a scraper sends
  `Authorization: Bearer <token>`. Scrape it from the private network
  ([core/metrics](../apps/api/src/core/metrics/README.md)).
- Observability is off until a backend is configured, and has two:
  NestJS Observe (`OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET`) or any
  OpenTelemetry endpoint such as the Nestrix server
  (`OTEL_EXPORTER_OTLP_ENDPOINT`)
  ([core/observability](../apps/api/src/core/observability/README.md)).
- Logs go to standard output, one JSON object per line, with secrets masked
  and the trace id when tracing is on
  ([core/logging](../apps/api/src/core/logging/README.md)).
- `APP_MODE` (or the `platform.mode` setting) puts the deployment in
  `read-only` or `maintenance`, for a risky migration or an incident
  ([modules/mode](../apps/api/src/modules/mode/README.md)).

## Processes and shutdown

`APP_ROLE` says what a process runs: `api` serves HTTP only, `worker` runs
the queue workers and scheduled jobs, `all` does both (the default;
development and small deployments). `node dist/worker` sets `worker` itself.
In production run API and worker containers of the same image so a heavy job
never slows a request, and scale each on its own. `WORKER_QUEUES` lets a
worker take only some queues. See [Background work](background-work.md).

On SIGTERM both processes shut down gracefully: `/health` turns 503 so the
load balancer stops sending traffic, workers finish the jobs they run, and the
modules close what they hold (Redis last). Give the orchestrator a stop
timeout longer than your longest job.

## More than one instance

Run several API instances and several workers freely. What they share:

- **Redis**, the same one: queues, the rate limit store
  (`RATE_LIMIT_STORE=redis`, the default), locks and the realtime fan-out.
  `memory` for the rate limits is for one instance and tests only.
- **The database.** Each process holds up to `DATABASE_POOL_MAX` connections
  (10): replicas times this must stay under PostgreSQL's `max_connections`.
- **Keys.** Secrets the app makes for itself (the access tokens' signing key,
  the cursor key, the idempotency and signed-URL keys, and others) are kept
  once in the database (`app_secrets`), so every instance reads the same
  ones ([core/secrets](../apps/api/src/core/secrets/README.md)); a value set
  in the environment wins. `DATA_ENCRYPTION_KEYS` and `BLIND_INDEX_KEYS`
  must be identical everywhere. Set `JWT_SECRET` and `CURSOR_KEYS` yourself
  if you want to own and rotate them.
- **Files.** Use S3. Local files under `/app/.data` are per container.
- **Scheduled jobs** run on one instance at a time (`core/locks`), so more
  workers never run a job twice.
- **Realtime.** socket.io uses the Redis adapter, so an event reaches clients
  on every instance. Clients connect with `transports: ['websocket']`; with
  polling the balancer needs sticky sessions
  ([modules/realtime](../apps/api/src/modules/realtime/README.md)). The
  session cookie needs no stickiness: sessions are in the database.

Behind a proxy, the client address comes from `X-Forwarded-For`, trusted only
from loopback and private networks.

## The operator CLI

`pnpm ops <command>` in development, and `node dist/cli <command>` in the
image, runs break-glass commands over the app's own services on a server that
holds its environment: create a tenant or first administrator, reset a
password, remove two-factor, manage queues and dead letters, run diagnostics,
generate and re-encrypt keys. Changing commands show what they will do and
ask first (`--yes` skips it). Writes are audited with the operator's OS user
and host. Commands: [src/cli](../apps/api/src/cli/README.md).

## What the host provides

This repository bundles no operations. The host brings:

- **HTTPS and certificates**, and any reverse proxy or load balancer in front.
  The API sends HSTS and expects to be served over HTTPS.
- **Backups** of PostgreSQL (and of the bucket), and a tested restore.
- **Monitoring and alerting** on the `/metrics` scrape, the readiness probe
  and the observability backend. The outbox backlog (`GET /v1/ops/outbox`,
  `lagMs`) is the number to alert on.
- **Deploying and releasing**: building and publishing the image, running
  `node dist/migrate` before each release, and rolling the instances.
- **Secrets storage**: the values of the variables above.
