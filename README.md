# nestjs-monorepo

A NestJS 12 backend template on first-party `@nestjs/*` packages: every
capability is a self-contained module you keep or delete.

```bash
pnpm install
pnpm services:up          # PostgreSQL
cp apps/api/env.example apps/api/.env
pnpm dev                  # http://localhost:3000/health
```

- [AGENTS.md](AGENTS.md): the rules the code follows.
- [PORTING.md](PORTING.md): what is here, and what is still to come.
