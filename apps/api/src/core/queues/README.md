# queues, redis, locks and the worker

- **Redis** (`core/redis`): `@Inject(REDIS)` is the ioredis client (keys under `REDIS_PREFIX:`); `RedisService.ping()` is true while Redis answers (readiness check). Variables: REDIS_URL, REDIS_PASSWORD, REDIS_SENTINELS, REDIS_SENTINEL_NAME, REDIS_PREFIX.
- **Queues** (this folder): `QueuesModule` holds the BullMQ connection and the job defaults (`DEFAULT_JOB_OPTIONS`). A module registers its own queue: `BullModule.registerQueue({ name: 'mail' })`, `@InjectQueue('mail')` to add, `@Processor('mail')` to consume. A queue that sets `defaultJobOptions` spreads `DEFAULT_JOB_OPTIONS` first.
- **Roles:** APP_ROLE `api` (HTTP, no processors, no cron jobs), `worker` (`node dist/worker`: processors and cron jobs), `all` (default). WORKER_QUEUES / WORKER_QUEUES_EXCLUDE split queues between workers; QUEUE_CONCURRENCY_<QUEUE> sets a queue's concurrency.
- **Errors:** `abortable()` stops waiting for an `add`; `queueUnavailable(error)` is the 503 for an add refused while Redis is down.
- **Locks and cron** (`core/locks`): `@Cron()` with `@OnOneInstance({ key })` runs a job on one instance; locks live in PostgreSQL (`locks` table). SCHEDULER=off turns jobs off.

To remove queues: delete this folder and its line in `app.module.ts`, and the modules that register a queue.
