# core/locks

Distributed locks (`@nestjs/locks`, kept in PostgreSQL by `DrizzleLockStore`: the `locks` table, expiry on the database's clock, fencing tokens from a sequence) and the scheduler (`@nestjs/schedule`).

- **A job:** a method with `@Cron(...)` and `@OnOneInstance({ key })`: every instance has the schedule, only one runs each tick.
- **Where jobs fire:** only in a process that runs workers (APP_ROLE `worker` or `all`, core/queues) and with SCHEDULER on. `SchedulerRegistry` exists everywhere.
- **A lock of your own:** inject the `@nestjs/locks` service and take a lock by key.
- Import `SharedLocksModule` once (`app.module.ts`); a module that has jobs needs it in the app, not in its own imports.

Variables (`locks.config.ts`): SCHEDULER (`on` by default; `off` for tests and an instance that must not run jobs).

Always there: core is never removed ([apps/api/AGENTS.md](../../../AGENTS.md), "Folders").
