# queues, redis, locks and the worker

- **Redis** (`core/redis`): `@Inject(REDIS)` is the ioredis client (keys under `REDIS_PREFIX:`); `RedisService.ping()` is true while Redis answers (readiness check). Variables: REDIS_URL, REDIS_PASSWORD, REDIS_SENTINELS, REDIS_SENTINEL_NAME, REDIS_PREFIX.
- **Queues** (this folder): `QueuesModule` holds the BullMQ connection and the job defaults (`DEFAULT_JOB_OPTIONS`). A module registers its own queue: `BullModule.registerQueue({ name: 'mail' })`, `@InjectQueue('mail')` to add, `@Processor('mail')` to consume. A queue that sets `defaultJobOptions` spreads `DEFAULT_JOB_OPTIONS` first.
- **Roles:** APP_ROLE `api` (HTTP, no processors, no cron jobs), `worker` (`node dist/worker`: processors and cron jobs), `all` (default). WORKER_QUEUES / WORKER_QUEUES_EXCLUDE split queues between workers; QUEUE_CONCURRENCY_<QUEUE> sets a queue's concurrency.
- **Once:** a job a retried caller (an outbox handler) may add again takes `onceJob(id)`: the id dedupes for 24 hours (BullMQ's deduplication with a ttl), also after the job left the queue. A bare `jobId` dedupes only while the job is kept, and `removeOnComplete` drops it after 1000 newer ones. `MailQueue.send(…, { jobId })` uses it.
- **Errors:** `abortable()` stops waiting for an `add`; `queueUnavailable(error)` is the 503 for an add refused while Redis is down.
- **Locks and cron** (`core/locks`): `@Cron()` with `@OnOneInstance({ key })` runs a job on one instance; locks live in PostgreSQL (`locks` table). SCHEDULER=off turns jobs off.

To remove queues: delete this folder and its line in `app.module.ts`, and the modules that register a queue.

- **Metrics:** `queue_oldest_waiting_seconds{queue}` on a worker's `/metrics`: how long the oldest waiting job of each queue has waited (0 when none), for every queue registered with `BullModule.registerQueue()`. Shared state: aggregate with max().
