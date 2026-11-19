# CI and the image

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, manual
runs and a nightly schedule (new advisories), and validates only.
`.github/workflows/publish.yml` publishes the image ("Publishing the
image"); deploying it is the deployment's own. `.github/workflows/release.yml`
publishes `create-nestjs-monorepo` for a release tag ("Releasing the
template").

| Job        | Runs                                                                                                                                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`   | `pnpm build`, `pnpm lint`, the raw-SQL check, knip, `pnpm test` and the unit coverage thresholds, `pnpm env:check`, `pnpm client:check`, `pnpm test:tools`, the migration lint (pull requests and pushes to main), the migrations check, then a generated feature's web pages type-checked and tested |
| `e2e`      | `pnpm test:e2e` on PostgreSQL and Redis service containers, and Garage (`pnpm storage:up`) for the S3 disk's test                                                                                                                                                                                     |
| `web-e2e`  | `pnpm test:e2e:web`: Playwright on the built API serving the built web app, on `compose.dev.yaml`'s services and the runner's Chrome                                                                                                                                                                  |
| `security` | `pnpm audit --prod --audit-level high`; Trivy: secrets, then high or critical misconfigurations                                                                                                                                                                                                       |
| `image`    | builds the Dockerfile (not pushed); Trivy fails on fixable high or critical vulnerabilities                                                                                                                                                                                                           |
| `ci`       | the one job to require in branch protection: it fails if any other did not succeed                                                                                                                                                                                                                    |

- **Migrations check.** `drizzle-kit check`, then `db:generate` (the app's and
  the test fixtures') must write nothing: a table changed without its migration
  fails with the diff. Fix: `pnpm --filter api db:generate` (or
  `db:generate:fixtures`) and commit.
- **No raw SQL.** `node tools/ci/raw-sql.mjs` (`pnpm raw-sql`) counts, per file
  of `apps/api/src`, the forms that bypass Drizzle's query builder
  (`.execute(sql\`…\`)`, `sql.raw()`, the driver's `pool/client.query()`). A
file may hold only what `tools/ci/raw-sql.allow.json`grants it, with the
reason (advisory locks,`set_config`, system catalogs, roles and grants:
what Drizzle has no API for); a new file or a higher count fails, and so
does a lower one until the list is lowered. `sql` fragments inside a
  builder query are not counted.
- **Dead code and coverage.** `pnpm knip` and the API's unit coverage
  thresholds (`pnpm --filter api test:cov`):
  [development, "Static checks" and "Coverage"](development.md#static-checks).
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
- **Service images** are read from `compose.dev.yaml` by the `images` job, so
  CI and development run the same PostgreSQL and Redis. The e2e harness needs a
  role that may create databases and roles: the services' superuser `app`
  (`TEST_DATABASE_URL`).
- **Actions** are pinned to a full commit SHA with the release in a comment;
  Dependabot (`.github/dependabot.yml`) raises npm (grouped), the Dockerfile's
  base images, `compose.dev.yaml` and the actions weekly.
- **Not here, on purpose:** deploy workflows, load tests, monitoring (AGENTS.md, "No bundled operations").

## The image

The `Dockerfile` has a build stage (pnpm `fetch`, an offline frozen-lockfile
install, both builds, `pnpm deploy --prod`) and a final stage with production
dependencies only, running as `node`. Base images are pinned by digest. How
to run it, its three commands and what it needs:
[deployment](deployment.md#the-image).

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

## Releasing the template

A `v1.2.3` tag whose version is `template.json`'s runs `release.yml`: the
create package's tests, `create-nestjs-monorepo@1.2.3` published to npm, and
the GitHub release with notes generated from the commits since the last tag
([upgrading](upgrading.md), "For the template's maintainer"). It publishes
with npm's trusted publishing, so no npm token is stored: once, on
npmjs.com, the package's "Trusted publisher" names this repository and the
workflow file `release.yml`. A tag whose package version is on npm already
publishes nothing (a re-run).
