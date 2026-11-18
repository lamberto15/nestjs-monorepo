# CI and the image

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, manual
runs and a nightly schedule (new advisories), and validates only.
`.github/workflows/publish.yml` publishes the image ("Publishing the
image"); deploying it is the deployment's own.

| Job        | Runs                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`   | `pnpm build`, `pnpm lint`, the raw-SQL check, knip, `pnpm test` and the unit coverage thresholds, `pnpm env:check`, `pnpm client:check`, `pnpm test:tools`, the migration lint (pull requests and pushes to main), the migrations check, then a generated feature's web pages type-checked and tested |
| `e2e`      | `pnpm test:e2e` on PostgreSQL and Redis service containers, and Garage (`pnpm storage:up`) for the S3 disk's test                                                                                    |
| `web-e2e` | `pnpm test:e2e:web`: Playwright on the built API serving the built web app, on `compose.dev.yaml`'s services and the runner's Chrome |
| `security` | `pnpm audit --prod --audit-level high`; Trivy: secrets, then high or critical misconfigurations                                                                                                       |
| `image`    | builds the Dockerfile (not pushed); Trivy fails on fixable high or critical vulnerabilities                                                                                                           |
| `ci`       | the one job to require in branch protection: it fails if any other did not succeed                                                                                                                    |

- **Migrations check.** `drizzle-kit check`, then `db:generate` (the app's and
  the test fixtures') must write nothing: a table changed without its migration
  fails with the diff. Fix: `pnpm --filter api db:generate` and commit.
- **No raw SQL.** `node tools/ci/raw-sql.mjs` counts, per file of
  `apps/api/src`, the forms that bypass Drizzle's query builder (`.execute(sql\`…\`)`,
`sql.raw()`, the driver's `pool/client.query()`). A file may hold only what
`tools/ci/raw-sql.allow.json`grants it, with the reason (advisory locks,`set_config`, system catalogs, roles and grants: what Drizzle has no API for);
a new file or a higher count fails, and so does a lower one until the list is
lowered. `sql` fragments inside a builder query are not counted.
- **Dead code (knip).** `pnpm knip` (`knip.jsonc`) fails on an unused file,
  export or dependency. The config lists only what knip cannot find (the
  `dist` entries, worker threads, generated code) with the reason.
- **Coverage.** `pnpm --filter api test:cov` gates the API's unit tests at the
  thresholds of `apps/api/vitest.config.ts`, a little under the measured levels:
  raise them when a change lifts the numbers, never lower. The e2e config
  reports coverage with `--coverage` and has no threshold.
- **Typed client.** `pnpm client:check` regenerates `packages/api-client`
  from the API's routes on the checkout as it is, before the generated
  feature adds its own, and fails when git sees a difference. Fix: `pnpm
  client:generate` and commit.
- **Migration lint.** On a pull request and on a push to `main`,
  `tools/migration-lint` reads the migrations added under `apps/api/drizzle/`
  (a pull request: to its base branch; a push: since `main` was at the
  push's `before` commit, which is why the job fetches the whole history on
  a push) with squawk (a pinned image, no
  network) and reports what breaks the release before it: drops, renames,
  retypes, `SET NOT NULL`, a `NOT NULL` column without a default, dropped
  defaults and constraints, `TRUNCATE`, `DELETE` and `UPDATE` without `WHERE`. Each
  finding goes to the job summary with file and line. On a pull request it
  fails the job, and a reviewed contract step takes the `destructive-migration`
  label (added after the last push, then re-run the job). On a push to `main`
  it is a warning only (`MIGRATION_LINT_FAIL` empty): the push is the
  owner's own reviewed change, and the warning is there for whoever deploys
  it. A project with a deployment to protect makes it blocking by setting
  `MIGRATION_LINT_FAIL: 'on'` for pushes too, or by landing changes through
  pull requests. A push that creates the branch has nothing to compare
  with and is skipped; one whose `before` is not in the history (a force
  push) fails, to be linted by hand with `--base`. Changing a merged
  migration and a `squawk-ignore` comment fail either way. Its tests need Docker with a working
  bind mount: where one is not available they fail locally and run in CI.
- **Hooks.** `lefthook.yml` (installed by `pnpm install`): Prettier, oxlint and
  the raw-SQL check on staged files; `commitlint.config.js` checks Conventional
  Commits. Skip once with `git commit --no-verify`.
- **Environment and demo data.** `pnpm run setup` writes `apps/api/.env` from
  `env.example` with generated keys (`--web-push` adds a VAPID pair, `--check`
  verifies an existing file; `tools/setup`). `pnpm db:seed:demo` fills a
  development database (apps/api/src/demo); `pnpm db:mark-dev` marks a database
  as one.
- **Service images** are read from `compose.dev.yaml` by the `images` job, so
  CI and development run the same PostgreSQL and Redis. The e2e harness needs a
  role that may create databases and roles: the services' superuser `app`
  (`TEST_DATABASE_URL`).
- **Actions** are pinned to a full commit SHA with the release in a comment;
  Dependabot (`.github/dependabot.yml`) raises npm (grouped), the Dockerfile's
  base images, `compose.dev.yaml` and the actions weekly.
- **Not here, on purpose:** deploy workflows, load tests, monitoring (AGENTS.md, "No bundled operations").

## The image

`docker build -t app .` at the root builds the API and the web app: a build
stage (pnpm `fetch`, frozen-lockfile install, both builds, `pnpm deploy
--prod`) and a final stage with production dependencies only, running as `node`. Base images
are pinned by digest. One image, three commands:

```bash
docker run app                    # node dist/main (the default)
docker run app node dist/worker   # the worker (no HTTP: turn the HEALTHCHECK off)
docker run app node dist/migrate  # the migrations, once per deploy
```

`/app/.data` is the only writable path (local files, the mail directory).
The web app's build is in `/app/web` (`WEB_ROOT`), served by the API from its
own origin (`apps/api/src/core/web`): one image, one origin.

## Publishing the image

`publish.yml` pushes the image to GitHub's registry,
`ghcr.io/<owner>/<repo>`:

- from `main`, once CI has passed on a push there: it builds and pushes
  `sha-<commit>`, then points `main` at that image by digest if the commit
  is still `main`'s head. Moving `main` is one run at a time for every
  commit (the `publish-main` group), and the head is checked again inside
  it, so a slower, older run never moves `main` back;
- from a tag `v1.2.3` (pushed by hand: `git tag v1.2.3 && git push origin
  v1.2.3`): nothing is built. The `sha-<commit>` image of the tagged commit,
  the one CI passed on `main`, gets `1.2.3` and `1.2` by digest
  (`docker buildx imagetools create`). A commit with no such image (not on
  `main`, its CI failed, or its image is still being published) is refused:
  push the tag again once it exists.

Never `latest`: a deployment names the version it runs. Each image carries
its commit (`GIT_SHA`, `org.opencontainers.image.revision`), a provenance
attestation and an SBOM. The package is private with the repository; a host
pulls it with a token that may read packages.
