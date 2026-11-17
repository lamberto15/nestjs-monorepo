# CI and the image

One workflow, `.github/workflows/ci.yml`, on pull requests, pushes to `main`,
manual runs and a nightly schedule (new advisories). It validates only:
publishing the image and deploying are the adopting project's own workflows.

| Job | Runs |
| --- | --- |
| `verify` | `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm env:check`, `pnpm test:tools`, and the migrations check |
| `e2e` | `pnpm test:e2e` on PostgreSQL and Redis service containers |
| `security` | `pnpm audit --prod --audit-level high`; Trivy: secrets, then high or critical misconfigurations |
| `image` | builds the Dockerfile (not pushed); Trivy fails on fixable high or critical vulnerabilities |
| `ci` | the one job to require in branch protection: it fails if any other did not succeed |

- **Migrations check.** `drizzle-kit check`, then `db:generate` (the app's and
  the test fixtures') must write nothing: a table changed without its migration
  fails with the diff. Fix: `pnpm --filter api db:generate` and commit.
- **Service images** are read from `compose.dev.yaml` by the `images` job, so
  CI and development run the same PostgreSQL and Redis. The e2e harness needs a
  role that may create databases and roles: the services' superuser `app`
  (`TEST_DATABASE_URL`).
- **Actions** are pinned to a full commit SHA with the release in a comment;
  Dependabot (`.github/dependabot.yml`) raises npm (grouped), the Dockerfile's
  base images, `compose.dev.yaml` and the actions weekly.
- **Not here, on purpose:** deploy and release workflows, image publishing,
  load tests, monitoring (AGENTS.md, "No bundled operations").

## The image

`docker build -t app .` at the root builds the API: a build stage (pnpm
`fetch`, frozen-lockfile install, `nest build`, `pnpm deploy --prod`) and a
final stage with production dependencies only, running as `node`. Base images
are pinned by digest. One image, three commands:

```bash
docker run app                    # node dist/main (the default)
docker run app node dist/worker   # the worker (no HTTP: turn the HEALTHCHECK off)
docker run app node dist/migrate  # the migrations, once per deploy
```

`/app/.data` is the only writable path (local files, the mail directory).
The web app is added later in the marked place in the Dockerfile and served by
the API.
