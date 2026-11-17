# AGENTS.md

A NestJS 12 backend template: pnpm and Turborepo, the API in `apps/api`.
It is a rewrite of an earlier template (`nestjs-monorepo-template`): the same
capabilities, brought over one at a time in the structure below.
[PORTING.md](PORTING.md) lists what is here and what is still to come.

Before changing code in `apps/api`, read [apps/api/AGENTS.md](apps/api/AGENTS.md)
(NestJS's first-party packages and their docs).

## Rules

1. **First-party first.** Use the `@nestjs/*` package when one exists, the
   way its documentation shows. Otherwise the standard library for the job.
   Custom code only when nothing fits, with a comment saying why.
2. **One module, one folder.** A module owns its routes, services, tables
   (`*.tables.ts`), environment variables (`*.config.ts`), texts, tests and
   documentation. `app.module.ts` lists the modules; removing one is deleting
   its folder and its line there.
3. **No central file a module must edit.** No shared environment schema, no
   schema barrel, no hand-written registry. Tables are found by glob
   (`drizzle.config.ts`), extension points by decorators.
4. **Dependencies go one way:** `core` ← `iam` ← `modules` ← `features`. A
   module never imports another module of its own level: they talk through
   events.
5. **Each rule is written once.** A permission condition, a validation or a
   limit has one definition; everything else is derived from it.
6. **Nothing until it is needed.** No layer, base class, option or helper
   before a second real caller.
7. **Layers:** a controller does HTTP only, a service owns the logic and its
   queries, a module wires them.
8. **No raw SQL.** Drizzle's query builder; `sql` only for an expression it
   lacks.
9. **Generate, never hand-write what a command produces:** `pnpm add`,
   `nest g`, `pnpm db:generate`.
10. **Tests prove the change.** Unit tests next to the code; e2e tests run
    against a real PostgreSQL. A ported capability comes with its e2e tests.
11. **Versions are the newest, pinned exactly.** Drizzle comes from its `rc`
    tag.

## Commands

```bash
pnpm install
pnpm services:up          # PostgreSQL (compose.dev.yaml)
cp apps/api/env.example apps/api/.env
pnpm dev                  # the API on http://localhost:3000
pnpm build && pnpm lint && pnpm test && pnpm test:e2e
```
