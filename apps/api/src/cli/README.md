# src/cli: the operator CLI

Break-glass commands over the app's own services, run on a server by someone
who holds its environment. A third entry next to `main.ts` and `worker.ts`
(`src/cli.ts`), built with nest-commander on `CliModule` (the app plus the
commands). It boots as APP_ROLE=api: no workers, relay or cron jobs, no HTTP
listener; what a command starts (a security alert's mail) waits in the queue.

```bash
pnpm ops <command>                                   # development
docker compose run --rm api node dist/cli <command>  # a deployment
```

Every changing command shows what it will do and asks; `--yes` skips the
question (scripts), and without a terminal it refuses instead. Writes run as
`system:ops` and each audit entry names the operator's OS user and host.
One-time passwords go to the terminal only, never the logs or audit.

| Command                                                             | Does                                        |
| ------------------------------------------------------------------- | ------------------------------------------- |
| `tenant:list`                                                       | tenants and member counts                   |
| `tenant:create <slug> -a <email> [-n name]`                         | tenant, roles, first administrator          |
| `admin:create <email> -t <tenant>`                                  | make an account an administrator            |
| `user:reset-password <email>`                                       | one-time password, signed out everywhere    |
| `user:remove-mfa <email>`, `user:unlock <email>`                    | no authenticator; clear the lockout         |
| `queue:list`, `queue:pause\|resume\|retry-failed <name>`            | queues (modules/ops)                        |
| `dead-letter:list`, `dead-letter:retry\|discard [ids...] [--all]`   | outbox dead letters                         |
| `user:list <tenant>`                                                | a tenant's users, roles, two-factor         |
| `setting:delete <key> --tenant <t> \| --platform`                   | remove a stored setting value (settings)    |
| `notifications:settle <email> [--before]`                           | drop a person's undelivered notifications   |
| `diagnostics [--test]`                                              | the integrations; safe probes (modules/ops) |
| `backlog:count\|discard\|retry <outbox\|mail> --tenant \| --global` | the outbox and mail backlog (modules/ops)   |
| `keys:generate`, `keys:status`, `keys:reencrypt`                    | encryption keys (modules/encryption-admin)  |

The commands call services; none repeats their logic. `accounts.service.ts` uses what iam exports for it: `AccountOperations`
(iam/account) and `TenantsService` (iam/tenants), imported by `CliModule`.

Tests: `accounts.e2e-spec.ts` (the plans), `confirm.spec.ts`, `operator.spec.ts`.
