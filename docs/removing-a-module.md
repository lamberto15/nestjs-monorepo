# Removing a module

Every module is on by default ([AGENTS.md](../AGENTS.md), "Decisions"): an
adopter drops what the app won't use. A module is its folder and its line in
`apps/api/src/app.module.ts` (rules 2 and 3), so removing one is deleting both,
then regenerating what was derived from it. `tools/module.mjs` does that, and
first says what it would do.

```bash
pnpm module:list                     # every module above core, and who uses it
pnpm module:remove forms             # a dry run: what would go, nothing changes
pnpm module:remove forms --apply     # does it
```

A module is named by its folder: `forms`, `modules/forms`, `iam/sso`,
`features/invoices`. A bare name must belong to one level only. `core` is never
removed: it is always there.

## It refuses while anything uses the module

Who uses whom is read from the imports, by the same code the dependency rule
is checked with (`apps/api/test/module-graph.ts`, used by
`src/module-graph.spec.ts`). The removal is refused, with each place listed,
when the module is used by:

- another module's code;
- the app's other code: `src/cli`, `src/demo`, `main.ts`, `openapi-dump.ts`;
- a test outside its folder (another module's spec, `apps/api/test`);
- the feature generator: its templates (`apps/api/schematics`), or another
  add-on's `<name>.addon.js` naming it;
- the web app outside the module's own pages (below), or a browser test
  that is not the module's own.

Remove those first, or change them so they no longer use the module, then run
it again. `pnpm module:list` shows what can go right away.

What a module needs so that nothing else must change when it goes:

- **Its tests are its own.** A test of a module's hook or section lives in
  that module's folder, not in the module that calls it: a record add-on's
  `merged` hook is tested in its own spec (`mergeTestItems()`, `test/records.ts`),
  a `@PersonalData` section in `<name>.personal-data.e2e-spec.ts`
  (`personalDataSection()`, `test/personal-data.ts`).
- **Its fixtures are its own:** `apps/api/test/fixtures/<name>/` goes with it,
  then `db:generate:fixtures` writes what that drops.
- **Its add-on is its own:** `<name>.addon.js` (adding-a-feature.md); the
  fixture generated with every add-on (`test/fixtures/generated-feature`) is
  generated again without it.
- **Its part of a shared web file is marked** `capability:<name>` (below).

## What it removes

| What                  | How it is found                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The folder            | `apps/api/src/<level>/<name>`: routes, services, tables, config, texts, tests, README, add-on; and `apps/api/test/fixtures/<name>`.                                                                                                                                                                                             |
| `app.module.ts`       | Read with the TypeScript compiler: the imports from the folder and their entries in `imports: [...]`. A comment above an entry goes with it when it heads that entry alone.                                                                                                                                                     |
| The web app's part    | `apps/web/src/features/<f>`, where `<f>` is the module's name or its route's (`naming-series` for `/v1/naming-series`): its pages, nav entry and tests; the `routes/` files built from it (besides it, they may take only the permission gate, `requirePermission`); `locales/<lng>/<f>.json`; `apps/web-e2e/test/<f>.spec.ts`. |
| Marked blocks         | Code a module adds to a shared web file sits between `// capability:<name> begin` and `// capability:<name> end` (`{/* … */}` in JSX). The blocks go; the file stays.                                                                                                                                                           |
| Doc lines             | A line that is only a link to the module (a list entry). A sentence that links to it is listed for you to rewrite.                                                                                                                                                                                                              |
| The raw SQL allowlist | The entries of its files (`tools/ci/raw-sql.allow.json`).                                                                                                                                                                                                                                                                       |

Then `--apply` runs the generators, never hand-writing what they write:

1. For an add-on, `pnpm --filter api feature:add` with the options in
   `test/fixtures/generated-feature.options.json`, the ones its drift test
   reads; then `pnpm --filter api db:generate:fixtures` (also when the module
   had fixtures of its own).
2. `pnpm --filter api db:generate --name remove-<name>`: the migration that
   **drops its tables**. Applied on the next deploy, it deletes them with their
   data: export what must be kept first, and read the SQL.
3. `pnpm env:example`: its variables leave `env.example`.
4. `pnpm client:generate`: its routes leave the OpenAPI document and the typed
   client.
5. The web route tree (`apps/web/src/routeTree.gen.ts`), as `pnpm feature:add`
   does.

The dry run lists all of it: the tables, the variables, the routes, the web
files, the module README's own removal note, the docs and the `PORTING.md`
lines that name it. After `--apply`, run `pnpm build && pnpm lint && pnpm test
&& pnpm test:e2e`, then commit the removal with what was regenerated.
