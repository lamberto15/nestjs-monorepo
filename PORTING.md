# Porting status

Every capability of the earlier template, and whether it is here yet. A box is
ticked when the capability's behaviour and its e2e tests are in this
repository.

## Core (`apps/api/src/core`)

- [x] config: each module checks its own variables (`readEnv`, `*.config.ts`)
- [x] database: the connection (`@nestjs/drizzle`, node-postgres)
- [x] health: readiness and liveness (`@nestjs/terminus`)
- [ ] database: migrations at deploy, roles, transactions, shared columns
- [ ] http: problem details, versioning, security headers, CORS, CSRF, lists
- [ ] logging and redaction
- [ ] redis, queues, locks
- [ ] tenancy (row-level security)
- [ ] encryption
- [ ] i18n
- [ ] mail
- [ ] metrics and observability

## Identity and access (`apps/api/src/iam`)

- [ ] auth (sign-in, sessions, tokens)
- [ ] account (password, email, MFA, passkeys, sessions)
- [ ] access (roles, grants, conditions, field permissions, API clients)
- [ ] organization (units, memberships)
- [ ] audit
- [ ] sso (OIDC, SAML, SCIM)
- [ ] captcha
- [ ] holds (legal holds)
- [ ] resources

## Modules (`apps/api/src/modules`)

- [ ] records, lists, fields, search, views
- [ ] tags, comments, attachments, images, storage, revisions, favorites,
      recents, templates, choices, sequences, custom-fields, expressions
- [ ] approvals, acknowledgments, bulk, merge, data-transfer, reports,
      data-quality, retention
- [ ] notifications, messaging, inbox, subscriptions, deliverability,
      webhooks, realtime, events, presence
- [ ] automations, forms, shares, ai, documents, calendars, recurrence,
      money
- [ ] settings, features, branding, quotas, usage, tenants, people,
      integrations, config-bundles, idempotency, auth-policy, client-errors,
      analytics, ops, mode

## Features (`apps/api/src/features`)

- [ ] notes (the example)

## Around the API

- [ ] the typed client (`packages/api-client`)
- [ ] the web app (`apps/web`, `packages/ui`)
- [ ] the worker process and the operator CLI
- [ ] CI
