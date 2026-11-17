# core/jobs: the list of a principal's long jobs

`JobIndex` (`JobsModule`) remembers which jobs (exports, imports, bulk runs) a user or client queued in a tenant, newest first, in Redis, so `GET` lists can page them with a cursor (BullMQ lists a queue by state only). `add()` before queueing, `page()` to read; entries expire with their jobs. `JOB_STATUSES` and `jobStatusFilter` are the shared `?status=` of those lists. `still-active` (does the queuing principal still act in the tenant?) is not here: it reads iam's tables, so it lives in iam.

Remove: delete this folder and its users.
