# nestjs-monorepo

A NestJS 12 template on first-party `@nestjs/*` packages: an API, a web app and a typed client. Every capability is a self-contained module you keep or delete.

```bash
pnpm install
pnpm services:up          # PostgreSQL and Redis
pnpm run setup            # apps/api/.env, with generated keys
pnpm dev                  # the API on http://localhost:3000, the web app on http://localhost:5173
pnpm feature:add          # your first feature
```

- [AGENTS.md](AGENTS.md): the rules the code follows, the decisions, and the map of the docs.
- [docs/architecture.md](docs/architecture.md): where things are and how they fit.
- [docs/development.md](docs/development.md): setup, commands and tests.
- [docs/adding-a-feature.md](docs/adding-a-feature.md): the feature generator.
- [docs/deployment.md](docs/deployment.md): the image and what a deployment needs.
- [PORTING.md](PORTING.md): what came from the earlier template and what changed.

Licence: [PolyForm Noncommercial 1.0.0](LICENSE).
