# apps/web and packages/ui: agent rules

The web app (Vite, React, TanStack Router and Query) and its components. These
add to the root [AGENTS.md](../../AGENTS.md). The API serves the built app
(`@nestjs/serve-static`): one origin, so the `__Host-sid` session cookie works;
in development Vite proxies the API's paths (`dev-proxy.ts`).

- **Components:** check Dice UI first, then shadcn, before writing one; add
  it with `shadcn add` (components, blocks, `@diceui/*`), then edit only what
  the task needs.
- **Generated, never hand-written:** the scaffold (`pnpm create vite`),
  shadcn components, the router's route tree (`src/routeTree.gen.ts`) and the
  typed client (`packages/api-client`: `generate`, from the API's OpenAPI
  document; the web app never edits `schema.ts` or `openapi.json`).
- **English only for now.** Texts go through i18next
  (`src/locales/en/<namespace>.json`), never hard-coded. A language is added
  by adding `src/locales/<lng>/` (a file per `en` namespace; other languages
  load on demand, `src/i18n.ts`) and naming it in `languages`, matching the
  API's `LOCALES`.
- **Tests:** `*.test.tsx` next to the code, with `renderApp()`, the msw
  handlers and `findToast()` (`src/test/`). One file:
  `pnpm --filter @nestjs-monorepo/web test src/features/tags/tags.test.tsx`.
  A browser test (`apps/web-e2e`, Playwright, against the real API) only for a
  user flow the change adds or changes.
- **Routes the API keeps:** the pages and the client follow the API's routes
  (PORTING.md lists a changed route); a page whose route the API does not have
  yet is removed with the route, not stubbed.
