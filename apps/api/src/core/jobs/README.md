# core/jobs: the list of a principal's long jobs

`JobIndex` (`JobsModule`) remembers which jobs (exports, imports, bulk runs) a user or client queued in a tenant, newest first, in Redis, so `GET` lists can page them with a cursor (BullMQ lists a queue by state only). `add()` before queueing, `page()` to read; entries expire with their jobs (`JOB_INDEX_TTL_MS`, 8 days). `JOB_STATUSES` and `jobStatusFilter` are the shared `?status=` of those lists. Whether the queuing principal still acts in the tenant is not here: it reads iam's tables, so the module that runs the job checks it (data-transfer's `PrincipalNow`, bulk's processor).

Remove: delete this folder and its users.
