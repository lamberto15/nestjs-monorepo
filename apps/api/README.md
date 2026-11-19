# api

The API: NestJS 12 on `@nestjs/platform-node`, PostgreSQL through Drizzle, Redis for queues and counters.

- `src/core`, `src/iam`, `src/modules`, `src/features`: the four levels ([docs/architecture.md](../../docs/architecture.md)). Each module has its own `README.md`.
- `src/main.ts` (the HTTP API), `src/worker.ts` (queues and scheduled jobs), `src/migrate.ts` (migrations), `src/cli.ts` (the operator CLI, `pnpm ops`), `src/openapi-dump.ts` (the OpenAPI document for the typed client), `src/demo/` (the demo seed, `pnpm db:seed:demo`).
- `drizzle/`: the migrations, generated from the `*.tables.ts` files (`pnpm --filter api db:generate`).
- `schematics/`: the feature generator (`pnpm feature:add`, [docs/adding-a-feature.md](../../docs/adding-a-feature.md)).
- `test/`: the e2e helpers and fixtures.
- `env.example`: every variable, generated from the modules' `*.config.ts`.

Commands, tests and the migration workflow: [docs/development.md](../../docs/development.md).
