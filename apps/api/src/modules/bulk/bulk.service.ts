import { randomUUID } from 'node:crypto';
import { Propagation, TransactionHost } from '@nestjs-cls/transactional';
import { InjectQueue } from '@nestjs/bullmq';
import { AuthorizationService } from '@nestjs/authorization';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { z } from 'zod';
import type { DatabaseTransactions } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { walkList } from '../../core/http/pagination.js';
import { JobIndex, type JobPage } from '../../core/jobs/job-index.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { inAuditRun } from '../../iam/audit/audit-run.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  principalKey,
  type Principal,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { recordValues, type RecordRow } from '../records/record.js';
import { BulkRepository } from './bulk.repository.js';
import { assertWritableFields } from '../records/record.routes.js';
import {
  Records,
  type RecordRegistration,
} from '../records/records.service.js';
import { bulkConfig } from './bulk.config.js';
import { BulkExtension } from './bulk.extension.js';
import { BulkTally, itemError, skipped } from './bulk.results.js';
import { actionsOf, bulkInputSchema } from './bulk.schemas.js';
import {
  BULK,
  BULK_GROUP,
  type BulkAction,
  type BulkItemResult,
  type BulkJob,
  type BulkRequest,
  type BulkResult,
  MAX_BULK_IDS,
} from './bulk.types.js';

/** A 400 validation_failed naming where the request is wrong. */
const invalid = (errors: { path: string; message: string }[]) =>
  new BadRequestException({
    code: 'validation_failed',
    message: 'The request is invalid.',
    errors,
  });

/** `schema.parse(value)`, its issues as a validation_failed under `path`. */
function parseAt<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(
      parsed.error.issues.map((issue) => ({
        path: [path, ...issue.path.map(String)].join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

const idsSchema = z.array(z.uuid()).min(1);

/** Keys of a list query that are not filters. */
const NOT_FILTERS = new Set([
  'limit',
  'page',
  'cursor',
  'count',
  'sort',
  'fields',
  'deleted',
  'lang',
]);

/** What a run acts on, parsed: these ids, or the records a list query matches. */
interface Selection {
  ids?: string[];
  query?: ListQuery;
}

/** A run as an item of GET /v1/bulk: its result's counts, not each item's. */
export interface BulkRunView {
  id: string;
  subject: string;
  action: BulkAction;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: Record<string, number>;
  /** When it was queued, a worker took it up, it ended (ISO 8601); null until then. */
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result?: Omit<BulkResult, 'results'>;
  error?: string;
}

/** The one reason a person can act on; anything else (a database error) stays in the logs. */
export const PRINCIPAL_GONE =
  'The account that started this bulk run is no longer active.';
export const publicReason = (reason: string | undefined) =>
  reason === PRINCIPAL_GONE
    ? reason
    : 'The bulk run stopped. Items done stay done; ask an administrator (the run id is in the logs).';

const iso = (millis: number | undefined) =>
  millis === undefined ? null : new Date(millis).toISOString();

/**
 * Whether the principal may see this run: theirs, started in this tenant.
 * Another tenant's run is unseen, even the same person's.
 */
const isOwn = (principal: Principal, job: Job<BulkJob, BulkResult>) =>
  job.data.tenantId === requireTenantId('A bulk run') &&
  principalKey(job.data.principal) === principalKey(principal);

/**
 * Acts on many records of a record type at once, each item through the
 * record's own store as its routes do (its permission, field checks,
 * hooks, legal holds, audit entry, domain event). Small runs (BULK_SYNC_LIMIT
 * ids) answer in the request; larger ones, and every `filter` selection, go
 * to the `bulk` queue and are reported to the principal who started them,
 * and to nobody else.
 */
@Injectable()
export class BulkService {
  constructor(
    @InjectQueue(BULK) private readonly queue: Queue<BulkJob, BulkResult>,
    private readonly repository: BulkRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly jobs: JobIndex,
    @Inject(bulkConfig.KEY)
    private readonly config: ConfigType<typeof bulkConfig>,
  ) {}

  /** The record's registration, when it took bulk operations (`BulkModule.forRecord()`). */
  registration(subject: string): RecordRegistration {
    const found = this.records.find(subject);
    if (!found?.extensions.some((e) => e instanceof BulkExtension)) {
      throw new NotFoundException(`${subject} takes no bulk operations.`);
    }
    return found;
  }

  /** Runs it now (the result), or queues it (`{ id, status: 'queued' }`). */
  async run(
    principal: RequestPrincipal,
    subject: string,
    request: BulkRequest,
  ): Promise<BulkResult | { id: string; status: 'queued' }> {
    const registration = this.registration(subject);
    if (!actionsOf(registration.declaration).includes(request.action)) {
      throw invalid([
        {
          path: 'action',
          message: `Not an action of ${subject}: send one of ${actionsOf(registration.declaration).join(', ')}.`,
        },
      ]);
    }
    if (!(await this.access.can(principal, request.action, subject))) {
      throw new ForbiddenException();
    }
    if ((request.ids === undefined) === (request.filter === undefined)) {
      throw invalid([
        { path: 'ids', message: 'Send ids or filter: one of them.' },
      ]);
    }
    let ids: string[] | undefined;
    if (request.ids !== undefined) {
      ids = [...new Set(parseAt(idsSchema, request.ids, 'ids'))];
      if (ids.length > MAX_BULK_IDS) {
        throw new BadRequestException({
          code: 'bulk_too_many',
          message: `At most ${MAX_BULK_IDS} ids at once: select more with a filter.`,
          limit: MAX_BULK_IDS,
        });
      }
    }
    // Checked now, so a typo is a 400, not a failed job. The job keeps them
    // raw (it travels as JSON: parsed dates would arrive as strings).
    const parsed = await this.parse(principal, registration, {
      ...request,
      ids,
    });
    const job: BulkJob = {
      tenantId: requireTenantId('A bulk run'),
      principal,
      subject,
      action: request.action,
      ...(ids ? { ids } : { filter: request.filter }),
      input: request.input,
      ip: request.ip,
    };
    // A filter's size is unknown until it runs: always a job.
    if (!ids || ids.length > this.config.syncLimit) {
      return this.enqueue(job);
    }
    const id = randomUUID();
    await this.started(job, id);
    const result = await inAuditRun(id, () =>
      this.execute(
        principal,
        registration,
        request.action,
        parsed.selection,
        parsed.input,
      ),
    );
    await this.finished(job, id, result);
    return result;
  }

  /**
   * The selection and input as a run takes them, parsed (the request's, or
   * a job's again: the principal's permissions may have changed since).
   */
  async parse(
    principal: Principal,
    registration: RecordRegistration,
    request: Omit<BulkRequest, 'ip'>,
  ) {
    const { declaration } = registration;
    const selection: Selection = { ids: request.ids };
    if (request.filter !== undefined) {
      // The list's query also takes paging, sort and the recycle bin:
      // meaningless for a run that acts on every match, so refused rather
      // than ignored (a `limit` would not limit). An empty filter would act
      // on every record the caller may: ask for at least one condition.
      const keys = Object.keys(request.filter);
      const stray = keys.filter((key) => NOT_FILTERS.has(key));
      if (stray.length) {
        throw invalid(
          stray.map((key) => ({
            path: `filter.${key}`,
            message: 'Not a filter: a bulk run acts on every match.',
          })),
        );
      }
      if (keys.length === 0) {
        throw invalid([
          {
            path: 'filter',
            message: 'At least one condition: a bulk run acts on every match.',
          },
        ]);
      }
      selection.query = registration.list.parse(request.filter);
      // Field-level: which records a run acts on would tell a hidden field's values.
      await this.access.assertQueryFields(
        principal,
        declaration.subject,
        selection.query,
        { reach: request.action },
      );
    }
    if (request.action !== 'update' && request.input !== undefined) {
      throw invalid([
        { path: 'input', message: `${request.action} takes no input.` },
      ]);
    }
    const input =
      request.action === 'update'
        ? parseAt(bulkInputSchema(declaration), request.input ?? {}, 'input')
        : undefined;
    return { selection, input };
  }

  /**
   * Performs the action on every selected record, BULK_GROUP at a time in
   * one transaction, each item in a savepoint of it: a 4xx rolls back and
   * fails that item alone; ids the selection did not yield are skipped.
   * Anything else (the database gone) rolls back its group and stops the
   * run; earlier groups stay done.
   */
  async execute(
    principal: Principal,
    registration: RecordRegistration,
    action: BulkAction,
    selection: Selection,
    input: unknown,
    {
      cap,
      progress,
    }: {
      cap?: number;
      progress?: (tally: BulkTally) => Promise<void>;
    } = {},
  ): Promise<BulkResult> {
    const tally = new BulkTally(cap);
    // Which ids were found: only for an ids selection (a filter's matches are unbounded).
    const seen = selection.ids ? new Set<string>() : undefined;
    for await (const batch of this.select(
      principal,
      registration,
      action,
      selection,
    )) {
      for (let start = 0; start < batch.length; start += BULK_GROUP) {
        const group = batch.slice(start, start + BULK_GROUP);
        for (const row of group) seen?.add(row.id);
        const results = await this.txHost.withTransaction(async () => {
          const results: BulkItemResult[] = [];
          for (const row of group) {
            try {
              // The store's own transaction joins this savepoint.
              await this.txHost.withTransaction(Propagation.Nested, () =>
                this.perform(principal, registration, action, row, input),
              );
              results.push({ id: row.id, status: 'done' });
            } catch (error) {
              const failure = itemError(error);
              if (!failure) throw error;
              results.push({ id: row.id, status: 'failed', error: failure });
            }
          }
          return results;
        });
        // Counted once committed: a group rolled back reports nothing done.
        for (const result of results) tally.add(result);
        await progress?.(tally);
      }
    }
    for (const id of selection.ids ?? []) {
      if (!seen!.has(id)) tally.add(skipped(id, action));
    }
    return tally.result(selection.ids);
  }

  /**
   * The records the principal may `action` among the ids, or all those the
   * query matches: in the query (`access.sqlFilter()`), in batches, keyset
   * by id (never an offset: the action may change what matches).
   */
  private async *select(
    principal: Principal,
    { declaration, feature, list }: RecordRegistration,
    action: BulkAction,
    { ids, query }: Selection,
  ): AsyncGenerator<RecordRow[]> {
    const deleted = action === 'restore';
    const scope = {
      table: feature.table,
      allowed: await this.access.sqlFilter(
        principal,
        declaration.subject,
        action,
        { deleted },
      ),
      softDelete: !!declaration.softDelete,
      deleted,
    };
    if (ids) {
      yield await this.repository.byIds(scope, ids);
      return;
    }
    yield* walkList<RecordRow>(feature.table.id, query!, (page) =>
      this.repository.page(scope, list.where(query!), page),
    );
  }

  /**
   * One item, as the record's route does it: the policy and, for a change,
   * the field-level check, on the row locked in the store's transaction
   * (here the item's savepoint in its group's transaction); then the
   * store's write, with its hooks, legal hold, audit entry and event. A 4xx
   * fails this item alone.
   */
  private async perform(
    principal: Principal,
    { declaration, feature, store }: RecordRegistration,
    action: BulkAction,
    row: RecordRow,
    input: unknown,
  ) {
    const policy = feature.policy;
    if (action === 'delete') {
      return store.delete(principal, row.id, {
        check: (current) =>
          this.authorization.authorize(policy, 'delete', principal, current),
      });
    }
    if (action === 'restore') {
      await this.authorization.authorize(policy, 'restore', principal, row);
      await store.restore(principal, row.id);
      return;
    }
    const body = input as Record<string, unknown>;
    await store.update(principal, row.id, recordValues(declaration, body), {
      input: body,
      check: async (current) => {
        await this.authorization.authorize(
          policy,
          'update',
          principal,
          current,
        );
        await assertWritableFields(
          this.access,
          principal,
          'update',
          declaration,
          body,
          current,
        );
      },
    });
  }

  /**
   * A run of this principal in this tenant: its state, progress and result.
   * Another tenant's run is a 404, even the same person's.
   */
  async status(principal: Principal, id: string) {
    const job = await this.queue.getJob(id);
    if (!job || !isOwn(principal, job)) {
      throw new NotFoundException(`Bulk run ${id} not found.`);
    }
    return this.view(job);
  }

  /**
   * The runs this principal handed to the workers in this tenant, newest
   * first, by cursor, optionally only those in a `status` or of an action
   * (`kind`), each as `status()` tells it without the result per item.
   * Those BullMQ still keeps (7 days after they end); runs answered in the
   * request were never jobs.
   */
  async list(
    principal: RequestPrincipal,
    query: {
      status?: BulkRunView['status'];
      kind?: BulkAction;
      limit: number;
      cursor?: string;
    },
  ): Promise<JobPage<BulkRunView>> {
    return this.jobs.page(
      BULK,
      requireTenantId('A bulk run'),
      principal,
      query,
      async (id) => {
        const job = await this.queue.getJob(id);
        if (!job || !isOwn(principal, job)) return null;
        const run = await this.view(job);
        if (!run.result) return run;
        const { results: _results, ...counts } = run.result;
        return { ...run, result: counts };
      },
      // Only the runs in this state, or of this action: skipped, not forgotten.
      (run) =>
        (query.status === undefined || run.status === query.status) &&
        (query.kind === undefined || run.action === query.kind),
    );
  }

  /** A run's state, progress and result. */
  private async view(
    read: Job<BulkJob, BulkResult>,
  ): Promise<Omit<BulkRunView, 'result'> & { result?: BulkResult }> {
    const id = read.id!;
    let job = read;
    const state = await job.getState();
    if (
      (state === 'completed' && job.returnvalue == null) ||
      (state === 'failed' && job.failedReason == null)
    ) {
      // It ended between the two reads (the job was read while it ran): read
      // it again, with its result or its reason.
      job = (await this.queue.getJob(id)) ?? job;
    }
    const base = {
      id,
      subject: job.data.subject,
      action: job.data.action,
      status:
        state === 'completed' || state === 'failed'
          ? state
          : state === 'active'
            ? ('running' as const)
            : ('queued' as const),
      progress:
        typeof job.progress === 'object'
          ? (job.progress as Record<string, number>)
          : { processed: 0 },
      // BullMQ's `timestamp` (queued), `processedOn` (a worker took it up)
      // and `finishedOn` (completed or failed), in milliseconds.
      createdAt: new Date(job.timestamp).toISOString(),
      startedAt: iso(job.processedOn),
      finishedAt:
        state === 'completed' || state === 'failed'
          ? iso(job.finishedOn)
          : null,
    };
    if (state === 'failed') {
      // Only a message written for people; never internal error text.
      return { ...base, error: publicReason(job.failedReason) };
    }
    return state === 'completed' ? { ...base, result: job.returnvalue } : base;
  }

  /**
   * Audits the start of a run: what it acts on, by how many ids or by a
   * filter. The run's one line in the audit log (`targetId` the run id):
   * its items' entries and its end carry the run id and expand it.
   */
  started(job: BulkJob, id: string) {
    return this.audit.record(job.principal, {
      action: 'bulk.started',
      targetType: 'bulk',
      targetId: id,
      details: {
        subject: job.subject,
        action: job.action,
        ...(job.ids ? { ids: job.ids.length } : { filter: job.filter }),
      },
      ip: job.ip,
    });
  }

  /** Audits its end with its counts; each item has the record's own entry. */
  finished(
    job: BulkJob,
    id: string,
    { done, failed, skipped: notFound }: BulkResult,
  ) {
    return this.audit.record(job.principal, {
      action: 'bulk.finished',
      targetType: 'bulk',
      targetId: id,
      runId: id,
      details: {
        subject: job.subject,
        action: job.action,
        done,
        failed,
        skipped: notFound,
      },
      ip: job.ip,
    });
  }

  /** Audits a queued run that failed for good (`reason` is for people), in the run. */
  failed(job: BulkJob, id: string, reason: string) {
    return this.audit.record(job.principal, {
      action: 'bulk.failed',
      targetType: 'bulk',
      targetId: id,
      runId: id,
      details: { subject: job.subject, action: job.action, reason },
      ip: job.ip,
    });
  }

  private async enqueue(job: BulkJob) {
    const jobId = randomUUID();
    // Listed for its principal (GET /bulk) before it is queued.
    await this.jobs.add([BULK], job.tenantId, job.principal, jobId);
    const added = await this.queue.add(job.subject, job, {
      jobId,
      // Never retried blindly: the items done would be done twice.
      attempts: 1,
      removeOnComplete: { age: 7 * 24 * 3600 },
    });
    await this.started(job, added.id!);
    return { id: added.id!, status: 'queued' as const };
  }
}
