# Porting status

Every capability of the earlier template, and whether it is here yet. A box is
ticked when the capability's behaviour and its e2e tests are in this
repository.

## Core (`apps/api/src/core`)

- [x] config: each module checks its own variables (`readEnv`, `*.config.ts`)
- [x] database: the connection (`@nestjs/drizzle`, node-postgres)
- [x] health: readiness and liveness (`@nestjs/terminus`)
- [x] config: `X_FILE` secrets, and `env.example` generated from the schemas
- [x] database: transactions that follow the call, shared columns, migrations
      at start and at deploy, error kinds, a database per e2e file
- [x] http: problem details, validation, versioning, security headers, CORS,
      CSRF, lists (filters, sorting, sealed cursors), ETags, OpenAPI
- [x] logging and redaction, the request log
- [x] redis, queues, the worker process, locks and scheduled jobs
- [x] encryption (data keys, blind indexes, re-encryption)
- [x] i18n (English; catalogs per module)
- [x] database roles (app, owner, maintenance) and tenancy: row-level
      security behind one seam, `TENANCY=single|multi`, tenant-scoped jobs
- [x] mail: transports, queued delivery with retries
- [x] throttling (Redis counters, the multiplier)
- [x] metrics (`/metrics`) and observability (NestJS Observe, or OTLP to a
      self-hosted backend such as Nestrix)
- [x] secrets: keys the app makes for itself, made once and kept in the
      database (list cursors, file links, tokens, idempotency)
- [x] outbox and domain events, workflows, idempotency keys, outbound HTTP
      (timeouts, retries, circuit breaking), the job index
- [x] mail: the suppression list is asked before a send (the list itself is
      `modules/deliverability`)
- [x] signed webhooks keep their raw body; a module registers the route a
      foreign page may post to (SAML) as a CSRF exclusion
- [x] mail delivery modes and budgets from settings and quotas, workflow
      payload encryption

## Identity and access (`apps/api/src/iam`)

- [x] auth: password sign-in, sessions, API keys, access tokens, the
      principal and its guards
- [x] account: password, email, sessions, token issue and refresh, MFA,
      passkeys, magic links, "Sign in with", devices and sign-in alerts
- [x] tenants: sign-up, switching, the operators' routes, deletion, domains
- [x] impersonation
- [x] break-glass: grants, and reading a tenant through one (a read-only
      transaction, read-only abilities, each read audited)
- [x] access: the permission catalog each module adds to, roles, dated
      grants, conditions, field permissions, the access API, the first-boot
      seed, the system principal
- [x] API clients and their keys, invitations
- [x] organization (units, the tree, dated memberships, unit conditions)
- [x] audit (the log, sign-in entries, retention)
- [x] audit: record changes and the audit pages
- [x] sso (OIDC, OAuth 2.0, SAML, verified domains, "SSO required") and
      SCIM 2.0
- [x] the seams between them (SSO required at password sign-in, SCIM-managed
      users and units, bot protection and maintenance on the account routes)
- [x] captcha (Turnstile, the stub, app attestation)
- [x] holds (legal holds)
- [x] auth-policy (tenant, unit and platform scopes), the personal data
      export, account deletion, consents

## Modules (`apps/api/src/modules`)

- [x] records (the engine a feature is declared on: nine files), relations,
      the recycle bin and its purge, lists, search
- [x] storage (local, S3, signed URLs), images, client-errors
- [x] money values (decimal arithmetic, currencies, columns), exchange rates,
      the expression language, field types
- [x] realtime (socket.io on Redis, sockets closed when a session, key,
      member or tenant ends), presence
- [x] settings and feature flags, app mode (maintenance, read-only), the
      features a deployment has (`GET /v1/features`)
- [x] quotas, usage metering
- [x] notifications (in-app, mail, web push, digests, watching), inbox
- [x] webhooks (outgoing, with deliveries and retries; incoming senders)
- [x] deliverability (bounces, complaints, the suppression list), messaging
      (SMS and mobile push)
- [x] sequences and naming series, calendars, recurrence, retention
- [x] record add-ons: tags, comments, attachments, revisions, favorites,
      recents, templates, choices, custom fields, computed fields, saved
      views, shares, approvals, acknowledgments, bulk, merge, data-transfer,
      reports, data-quality, and the record side of sequences, webhooks,
      notifications, recurrence and retention
- [x] automations, ai, documents, branding, people, config-bundles, ops
      (dead letters, job admin, diagnostics, backlog), encryption admin
- [x] forms
- [x] mcp: tools for AI agents at `POST /v1/mcp` (new: the earlier template
      had none)

## Features (`apps/api/src/features`)

- [x] the generator (`pnpm feature:add`, Nest schematics), proved by a
      generated fixture that may not drift from it. No sample feature ships
      (`notes` is not ported: AGENTS.md, "Decisions").
- [ ] the web pages of a generated feature

## Around the API

- [ ] the typed client (`packages/api-client`)
- [ ] the web app (`apps/web`, `packages/ui`)
- [x] the worker process (`node dist/worker`)
- [x] the operator CLI (`pnpm ops`)
- [x] repository tooling: the raw SQL check, knip, git hooks, commit
      message rules, migration lint, setup, the demo seed
- [ ] the docs pages
- [x] CI (one workflow, the image, Dependabot: `docs/ci.md`)

## Not ported, on purpose

- The bundled operations stack (backups, monitoring, load tests, pgbouncer,
  PDF rendering service): a deployment's own.
- Sentry, and the monitoring and reporting database roles: errors go to the
  chosen observability backend.
- `analytics` (nightly aggregates for a reporting role): analytical
  reporting is done outside the app, in a store fed by replication. Scheduled
  exports (`reports`) stay, with data-transfer.
- `feature:sync`, `feature:remove` and `capability:remove`: a feature is
  changed by editing its files and running `pnpm db:generate`; a feature or
  a capability is removed by deleting its folder and its line in a module.
- Caddy's certificate route (`/internal/domains/allowed`) and `FILES_ORIGIN`.
- The deployment-wide `mail.dailyLimit` (a tenant's `mail.perDay` quota
  stays), the mail signature partial, and the metrics
  `db_incidents_total{trigger=pool_waiting}`, `mail_budget_used_ratio` and
  `approvals_open`.
- Release Please and the commit-message workflow: to add with the remote.

## Changed on the way

- A variable is described once, in its module's `*.config.ts`;
  `env.example` is generated from there (`pnpm env:example`).
- Readiness checks are contributed by the module that owns the dependency
  (`@ReadinessCheck()`), not listed in the health module.
- Every point in time is `timestamptz(3)` (`at()`), so no query truncates
  to the millisecond.
- A queue is registered by the module that owns it; there is no central
  list of queues.
- A permission condition is declared once, as column and value; the old
  template wrote each one twice (a CASL form and an SQL form).
- A module registers its permissions in its own imports
  (`AccessModule.forFeature()`); there is no list in a root module.
- No action may be named `manage` (CASL reads it as every action):
  `Approval.manage` and `Ops.manage` get another name when ported.
- `PATCH /access/users/:id` announces a deactivation as an event; sessions
  end on the member's next request.
- A route asks for bot protection with `@Captcha()`, metadata that the
  captcha module's global guard reads; it runs before a route's own limits
  (the old one ran after the sign-in limit).
- `GET /v1/auth/captcha` tells a page which widget to render (the old
  template put it in `/auth/methods`).
- Realtime events are declared where they are pushed
  (`defineRealtimeEvent`); the OpenAPI document's `x-realtime-events` is
  collected from them. A record add-on's events appear there only when a
  feature uses the add-on. Presence names a record type by its permission
  subject (`Note`), not a slug.
- Operators are the members of the tenant named by `OPERATOR_TENANT`
  (with `TENANCY=single`, of the one tenant); the tenants table has no
  operator column.
- Domain events have no fixed channels (webhook, notification, realtime):
  a module that delivers them subscribes with `@OnDomainEvent`.
- A feature is nine files on `modules/records`; an add-on registers with
  `XModule.forRecord()` in the feature's module. There is no central
  resource registry (`iam/resources`) and no engine file an add-on edits.
- Lists: `GET /v1/lists/:subject` answers `capabilities` as an open map,
  filled by the add-ons a record has.
- Settings have their own permissions (`Setting.read`, `Setting.update`)
  in place of `Access.manageSettings`; usage has `Usage.*`.
- API clients are under `/v1/access/clients`; `refresh` no longer takes
  a `tenantId` (switching tenants is its own route).
- Invitations: `resend` is a deprecated alias of `POST …/:id/send`.
- Web push devices are `PUT /v1/devices`; mobile devices moved to
  `/v1/messaging/devices`. Watching a record is
  `PUT /v1/subscriptions/{subject}/{recordId}`.
- Mail suppressions: `view` and `manage` became `read`, `create` and
  `delete`; delivery events are no longer audited one by one.
- SMS metrics are process counters (`sms_sent_total`,
  `sms_spend_minor_total`, `sms_blocked_total`); the per-tenant budget
  gauge is gone.
- Users linked to an identity provider are rows of `sso_identities`; SCIM
  remembers the accounts it switched off (`scim_deprovisioned_users`).
- Maintenance and feature switches are route metadata in core
  (`@AllowInMaintenance()`, `@Feature()`), read by the mode and features
  modules.
- Modules of one level may use each other one way, through exports;
  `src/module-graph.spec.ts` checks it.
- The global rate limit counts HTTP requests only; an MCP tool call or a
  socket message was counted when it arrived.
- Usage: `GET /v1/tenant/usage` is `GET /v1/quotas`, and a tenant's for
  the operators is `GET /v1/tenants/{id}/quotas`.
- Acknowledgments moved from attachments to the record:
  `/v1/<path>/{id}/acknowledgments`.
- The account export's status is `GET /v1/account/exports/{id}`; its rows
  are `kind`, `tenantId`, `id`, `data`.
- Data transfer is under `/v1/data`; an export or import is named by the
  record's path; there is no JSON format (csv, xlsx). The operators'
  `POST /v1/tenants/{id}/export` needs `Access.exportTenants` and leaves out
  hashes, secrets and encrypted columns.
- Bulk: `POST /v1/<path>/bulk`, one transaction per record; a run names its
  subject.
- Permissions renamed, none called `manage`: `DataQuality.read|scan|resolve`,
  `Approval.read|abandon|cancel|managePolicies`, `Automation.configure`,
  `Branding.update`, `ConfigBundle.export|apply`, `Access.testIntegrations`
  (ops diagnostics), `Access.managePlatformAuthPolicy`.
- Webhook scope (`/v1/access/clients/{clientId}/webhook-scope`) asks for
  `Webhooks.manageEndpoints` and authority over the client (was
  `Access.manageClients`).
- Event and notification types are kebab-case: `security.new-sign-in`,
  `security.password-changed`, `security.password-breached`,
  `security.passkey-added`, `security.passkey-removed`,
  `security.break-glass-started`; `security.mfaChanged` is
  `security.mfa-enabled` and `security.mfa-disabled`; the webhook
  `security.apiKeyRotated` is `security.api-key-rotated`. A record's webhook
  types are `<item>.created` and so on.
- Security alerts are mailed by `iam/account` (an alert may have no tenant)
  and also stored as notifications in the tenant the person acted in.
- Automations: one condition expression replaces the filters; the webhook
  action sends `<item>.automation-matched`.
- AI: a source is a collection path; the daily budget is the quota
  `ai.tokensPerDay` (was `AI_TENANT_DAILY_TOKENS`); refused with
  `ai_quota_exceeded`.
- Documents: an issued PDF is a locked attachment that records the fields it
  shows; a reader lacking one of them sees it listed but may not open it.
- Custom field values are in their own table; the body key stays `custom`.
  Computed fields are computed when a record is presented, not stored.
- Ops: diagnostics are `/v1/ops/diagnostics/{name}`; the mail backlog is
  global only. The database pool is not a readiness check: it is in the
  `db_pool_*` metrics.
- Auth policy has unit and platform scopes
  (`/v1/access/auth-policy/units/{unitId}`, `/platform`).
- Attachments: a version is addressed by its number
  (`/v1/attachments/{id}/versions/{version}`); files appear in
  `GET /v1/search` when `ATTACHMENT_TEXT_SEARCH` is on.
- Workflow inputs and outputs are encrypted when `DATA_ENCRYPTION_KEYS` is
  set.
- A record add-on's routes are in the OpenAPI document only when a feature
  uses the add-on, so with no feature the typed client has none of them.
