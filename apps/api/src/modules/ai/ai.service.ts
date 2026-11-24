import { createHash } from 'node:crypto';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  AiModelError,
  AiOutputError,
  type AiSchema,
  AiService as Models,
} from '@nestjs/ai';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { t } from '@nestjs/i18n';
import { APICallError } from 'ai';
import { type Queue, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import { REDIS } from '../../core/redis/redis.js';
import { type TenantEnvelope } from '../../core/tenancy/tenant-job.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import {
  type Principal,
  principalKey,
  type RequestPrincipal,
} from '../../iam/auth/principal.js';
import { QuotasService } from '../quotas/quotas.service.js';
import { periodOf } from '../quotas/quota.js';
import { recordView } from '../records/record.js';
import { Records } from '../records/records.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { aiConfig } from './ai.config.js';
import { aiFailed, aiReady } from './ai.events.js';
import { aiEnabled } from './ai.models.js';
import { AI_TOKENS } from './ai.quota.js';
import type { AiRequest, AiRunView } from './ai.schemas.js';
import { AI_ENABLED } from './ai.settings.js';
import { AiSources } from './ai.source.js';
import { AiRepository } from './ai.repository.js';
import type { AiRunRow, AiRunStatus } from './ai.tables.js';
import { AI_TASKS, type AiTask } from './ai.tasks.js';

/** The queue of AI runs. */
export const AI = 'ai';

/** What a queued run carries: the run, who asked (checked again), and the tenant. */
export interface AiJob extends TenantEnvelope {
  readonly tenantId: string;
  id: string;
  principal: RequestPrincipal;
}

/** Why a run failed: the codes of `ai.errors` in the catalog. */
export const AI_ERRORS = {
  principalGone: 'principalGone',
  recordGone: 'recordGone',
  invalid: 'invalid',
  disabled: 'disabled',
  rejected: 'rejected',
  unavailable: 'unavailable',
} as const;
type AiError = (typeof AI_ERRORS)[keyof typeof AI_ERRORS];

/** How long a finished run's output stays in the queue's result, in seconds. */
export const OUTPUT_KEPT_SECONDS = 3600;

const OPEN: AiRunStatus[] = ['queued', 'running'];

/** A run that cannot succeed, for a reason people can act on: not retried. */
class AiFailure extends UnrecoverableError {
  constructor(readonly code: AiError) {
    super(code);
  }
}

/**
 * The AI helper: a record that imports `AiModule.forRecord()` takes it, a
 * queue worker asks the model for a structured answer (@nestjs/ai, validated
 * with Zod) about the record's fields as the requester may read them, and
 * the requester follows the run at GET /v1/ai/runs/{id} and hears `ai.ready`
 * over realtime. The row is the usage record (model id, prompt version,
 * tokens): it keeps no prompt and no output, which are the record's personal
 * data. The output lives in the job's result for an hour, readable by the
 * requester only. The tokens count against the tenant's daily quota
 * (AI_TOKENS).
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('Ai');

  constructor(
    private readonly repository: AiRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    @InjectQueue(AI) private readonly queue: Queue<AiJob>,
    private readonly sources: AiSources,
    private readonly records: Records,
    private readonly models: Models,
    private readonly audit: AuditService,
    private readonly realtime: Realtime,
    private readonly settings: SettingsService,
    private readonly quotas: QuotasService,
    @Inject(aiConfig.KEY) private readonly config: ConfigType<typeof aiConfig>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Asks for a run: checked now (the helper on, the tenant opted in, the
   * record readable by the requester, the daily token quota), done by a
   * worker. 503 `ai_unavailable` without a key; 403 `ai_disabled` until the
   * tenant opts in; 429 `ai_quota_exceeded`; 409 `ai_pending` while the same
   * requester's run of the record and task is open.
   */
  async request(principal: RequestPrincipal, request: AiRequest, ip?: string) {
    const off = await this.offFor(principal);
    if (off === 'unavailable') {
      throw new ServiceUnavailableException({
        code: 'ai_unavailable',
        message: t('ai.unavailable'),
      });
    }
    if (off === 'disabled') {
      throw new ForbiddenException({
        code: 'ai_disabled',
        message: t('ai.disabled'),
      });
    }
    const record = this.sources.get(request.source);
    if (!record) {
      throw new NotFoundException(
        t('ai.unknownSource', { args: { source: request.source } }),
      );
    }
    // A 404 for a record the requester may not read.
    await this.records
      .of(record.subject)
      .store.findOne(request.recordId, { visibleTo: principal });
    const tenantId = requireTenantId('An AI run');
    if (principal.tenantId !== tenantId) {
      throw new Error("An AI run is done in its requester's tenant only.");
    }
    const task = AI_TASKS[request.task];
    await this.assertQuota();
    const pending = {
      source: request.source,
      recordId: request.recordId,
      task: task.name,
      requestedBy: principalKey(principal),
    };
    const row = await this.txHost
      .withTransaction(async () => {
        const row = await this.repository.insert({
          ...pending,
          subject: record.subject,
          promptVersion: task.version,
          status: 'queued',
        });
        await this.audit.record(principal, {
          action: 'ai.requested',
          targetType: 'ai_run',
          targetId: row.id,
          details: {
            source: request.source,
            subject: record.subject,
            recordId: request.recordId,
            task: task.name,
            promptVersion: task.version,
          },
          ip,
        });
        return row;
      })
      .catch(async (error: unknown) => {
        if (databaseErrorKind(error) !== 'unique_violation') throw error;
        const open = await this.repository.findOpen(pending, OPEN);
        throw new ConflictException({
          code: 'ai_pending',
          message: t('ai.pending'),
          id: open?.id,
        });
      });
    try {
      await this.queue.add(
        task.name,
        { id: row.id, principal, tenantId },
        {
          // The run's id: a job is queued once per run.
          jobId: row.id,
          attempts: this.config.attempts,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: OUTPUT_KEPT_SECONDS },
          removeOnFail: { age: OUTPUT_KEPT_SECONDS },
        },
      );
    } catch (error) {
      await this.fail(
        { id: row.id, principal, tenantId },
        AI_ERRORS.unavailable,
      );
      throw error;
    }
    return { id: row.id, status: 'queued' as const };
  }

  /**
   * Why the helper is off for the principal, or null while it is on: no
   * key on this server (`unavailable`), or the tenant's opt-in off or the
   * operators' enforced platform value (`disabled`). Asked when a run is
   * requested and again when a worker starts it.
   */
  private async offFor(principal: RequestPrincipal) {
    if (!aiEnabled(this.config)) return 'unavailable' as const;
    if (!(await this.settings.get(AI_ENABLED, principal))) {
      return 'disabled' as const;
    }
    return null;
  }

  /** 429 `ai_quota_exceeded` once the tenant's tokens today reach its limit. */
  private async assertQuota() {
    const limit = await this.quotas.limitOf(AI_TOKENS);
    if (limit === null || (await this.quotas.used(AI_TOKENS)) < limit) return;
    const { resetsAt } = periodOf(AI_TOKENS.period);
    throw new HttpException(
      {
        code: 'ai_quota_exceeded',
        message: t('ai.quotaExceeded', {
          args: { limit, resetsAt: resetsAt.toISOString() },
        }),
        quota: { key: AI_TOKENS.key, limit, resetsAt: resetsAt.toISOString() },
        retryAfter: Math.max(
          1,
          Math.ceil((resetsAt.getTime() - Date.now()) / 1000),
        ),
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * What a run spent counts against the quota, even past its limit: what
   * does not fit is added up to the limit, so the next request is refused.
   */
  private async spend(tokens: number) {
    if (tokens <= 0) return;
    const outcome = await this.quotas.tryConsume(AI_TOKENS, tokens);
    if (!outcome.allowed && outcome.limit !== null) {
      await this.quotas.tryConsume(
        AI_TOKENS,
        Math.max(outcome.limit - outcome.used, 0),
      );
    }
  }

  /** A run the principal asked for, with its output while it is kept; else a 404. */
  async status(principal: Principal, id: string): Promise<AiRunView> {
    const row = await this.repository.findById(id);
    // The output is the requester's: what they could read of the record.
    if (!row || row.requestedBy !== principalKey(principal)) {
      throw new NotFoundException(t('ai.runNotFound'));
    }
    let output: Record<string, unknown> | null = null;
    if (row.status === 'completed') {
      const job = await this.queue.getJob(id);
      // The row commits before BullMQ stores the job's result: until the job
      // has finished, the run is still running for its reader.
      if (job && !job.finishedOn) {
        return view({ ...row, status: 'running' }, null);
      }
      // Kept for OUTPUT_KEPT_SECONDS after it finished: BullMQ removes an
      // old job only when a later one finishes, so the age is checked here.
      const kept: unknown =
        job?.finishedOn &&
        Date.now() < job.finishedOn + OUTPUT_KEPT_SECONDS * 1000
          ? job.returnvalue
          : null;
      output =
        kept && typeof kept === 'object'
          ? (kept as Record<string, unknown>)
          : null;
    }
    return view(row, output);
  }

  /** On the worker: asks the provider (or the cache) and completes the run. */
  async run(
    job: AiJob,
    principal: RequestPrincipal | null,
  ): Promise<Record<string, unknown>> {
    const row = await this.repository.updateIn(job.id, OPEN, {
      status: 'running',
    });
    if (!row) {
      throw new UnrecoverableError(`AI run ${job.id} is not open: not run.`);
    }
    if (!principal) throw new AiFailure(AI_ERRORS.principalGone);
    const record = this.sources.get(row.source);
    if (!record) {
      throw new UnrecoverableError(`No AI source "${row.source}".`);
    }
    const task = AI_TASKS[row.task as keyof typeof AI_TASKS] as
      AiTask | undefined;
    if (!task) throw new UnrecoverableError(`No AI task "${row.task}".`);
    // Switched off since it was asked for (the tenant opted out, the
    // operators forced it off, the key removed): the record is not read and
    // nothing is sent. Failed for good, as a refusal is.
    if (await this.offFor(principal)) {
      throw new AiFailure(AI_ERRORS.disabled);
    }
    const content = await this.content(principal, record.subject, row.recordId);
    const cheap = task.tier === 'cheap';
    const model = cheap ? this.config.cheapModel : this.config.model;
    const prompt = framePrompt(task, content);
    // The key names tenant, model and prompt version, plus the exact prompt
    // (so field-level differences between callers never share an answer).
    const cacheKey = `tenant:${requireTenantId('An AI run')}:ai:cache:${createHash(
      'sha256',
    )
      .update(JSON.stringify([task.name, task.version, model, prompt]))
      .digest('hex')}`;
    const ttl = this.config.cacheTtlSeconds;
    let output: Record<string, unknown> | undefined;
    let cached = false;
    let usage = { inputTokens: 0, outputTokens: 0 };
    let answeredBy = model;
    if (ttl > 0) {
      const hit = await this.redis.get(cacheKey).catch(() => null);
      if (hit) {
        output = JSON.parse(hit) as Record<string, unknown>;
        cached = true;
      }
    }
    if (!output) {
      // What the provider reported, even for an answer that is then refused.
      const spent = { inputTokens: 0, outputTokens: 0 };
      let result;
      try {
        // The model is sent the task's JSON Schema; the answer is validated below.
        result = await this.models.generateObject({
          model: cheap ? 'cheap' : 'default',
          label: task.name,
          instructions: task.system,
          prompt,
          schema: unvalidated(task.schema),
          schemaName: 'answer',
          schemaDescription: task.description,
          maxOutputTokens: this.config.maxOutputTokens,
          onUsage: (event) => {
            spent.inputTokens += event.usage.inputTokens;
            spent.outputTokens += event.usage.outputTokens;
          },
        });
      } catch (error) {
        if (error instanceof AiOutputError) {
          // Not JSON at all. Spent, but unusable: never retried (it would be paid twice).
          await this.complete(row, principal, {
            status: 'failed',
            usage: spent,
            model,
            error: AI_ERRORS.invalid,
          });
          throw new AiFailure(AI_ERRORS.invalid);
        }
        // Rate limit, overload, network, timeout: the queue retries the run.
        if (
          error instanceof AiModelError &&
          !(APICallError.isInstance(error.cause) && !error.cause.isRetryable)
        ) {
          throw new Error(AI_ERRORS.unavailable, { cause: error });
        }
        this.logger.warn('The AI provider refused a run', {
          id: row.id,
          error: String(error),
        });
        throw new AiFailure(AI_ERRORS.rejected);
      }
      usage = {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      };
      answeredBy = result.model.modelId;
      const parsed = task.schema.safeParse(result.object);
      if (!parsed.success) {
        // Spent, but unusable: never retried (it would be paid twice).
        await this.complete(row, principal, {
          status: 'failed',
          usage,
          model: answeredBy,
          error: AI_ERRORS.invalid,
        });
        throw new AiFailure(AI_ERRORS.invalid);
      }
      output = parsed.data as Record<string, unknown>;
      if (ttl > 0) {
        await this.redis
          .set(cacheKey, JSON.stringify(output), 'EX', ttl)
          .catch(() => undefined);
      }
    }
    await this.complete(row, principal, {
      status: 'completed',
      usage,
      model: answeredBy,
      cached,
    });
    // After the commit: a client never hears of a run that rolled back.
    this.realtime.toPrincipal(principal, aiReady, {
      id: row.id,
      subject: row.subject,
      recordId: row.recordId,
      task: row.task,
    });
    this.logger.log('AI run completed', {
      id: row.id,
      task: row.task,
      model: answeredBy,
      cached,
      ...usage,
    });
    return output;
  }

  /**
   * The record as the requester may read it now: its title (the first text
   * field) and its own fields, field-level access applied (what they may
   * not read is never sent). A record gone or no longer theirs fails the run.
   */
  private async content(
    principal: RequestPrincipal,
    subject: string,
    recordId: string,
  ) {
    const { store, presenter, declaration } = this.records.of(subject);
    let shown: Record<string, unknown>;
    try {
      const row = await store.findOne(recordId, { visibleTo: principal });
      shown = await presenter.one(
        principal,
        recordView(declaration, row) as Record<string, unknown>,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new AiFailure(AI_ERRORS.recordGone);
      }
      throw error;
    }
    const fields: Record<string, string | number | boolean | null> = {};
    for (const name of Object.keys(declaration.fields)) {
      if (!(name in shown)) continue; // not readable by them
      const value = shown[name];
      fields[name] =
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
          ? value
          : JSON.stringify(value);
    }
    const title = Object.values(fields).find((v) => typeof v === 'string');
    return { title: title ?? declaration.noun, fields };
  }

  /** The run's outcome and its audit entry, then its tokens against the quota. */
  private async complete(
    row: AiRunRow,
    principal: RequestPrincipal,
    outcome: {
      status: 'completed' | 'failed';
      usage: { inputTokens: number; outputTokens: number };
      model: string;
      cached?: boolean;
      error?: AiError;
    },
  ) {
    await this.txHost.withTransaction(async () => {
      const done = await this.repository.updateIn(row.id, OPEN, {
        status: outcome.status,
        model: outcome.model,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cached: outcome.cached ?? false,
        error: outcome.error ?? null,
      });
      if (!done) return;
      await this.audit.record(principal, {
        action: outcome.status === 'completed' ? 'ai.completed' : 'ai.failed',
        targetType: 'ai_run',
        targetId: row.id,
        details: {
          source: row.source,
          recordId: row.recordId,
          task: row.task,
          promptVersion: row.promptVersion,
          model: outcome.model,
          cached: outcome.cached ?? false,
          ...outcome.usage,
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      });
    });
    await this.spend(outcome.usage.inputTokens + outcome.usage.outputTokens);
  }

  /**
   * A run that failed for good: state and audit in one transaction, then the
   * requester told. Idempotent (only an open run fails).
   */
  async fail(
    job: AiJob,
    reason: AiError,
    principal: Pick<Principal, 'kind' | 'id'> = job.principal,
  ) {
    const failed = await this.txHost.withTransaction(async () => {
      const failed = await this.repository.updateIn(job.id, OPEN, {
        status: 'failed',
        error: reason,
      });
      if (failed) {
        await this.audit.record(principal as Principal, {
          action: 'ai.failed',
          targetType: 'ai_run',
          targetId: failed.id,
          details: {
            source: failed.source,
            recordId: failed.recordId,
            task: failed.task,
            error: reason,
          },
        });
      }
      return failed;
    });
    if (!failed) return;
    this.realtime.toPrincipal(principal as Principal, aiFailed, {
      id: failed.id,
      subject: failed.subject,
      recordId: failed.recordId,
      error: reason,
    });
  }

  /** The reason a failure carries, when it is one of ours. */
  reasonOf(error: Error): AiError {
    return error instanceof AiFailure
      ? error.code
      : (Object.values(AI_ERRORS) as string[]).includes(error.message)
        ? (error.message as AiError)
        : AI_ERRORS.unavailable;
  }
}

/**
 * The task's schema as the model is sent it (its JSON Schema), but without
 * the package's validation: an answer that does not match rejects with an
 * AiOutputError that carries no token usage, and the run must still count
 * the tokens it spent against the tenant's quota. The run validates the
 * answer itself, right after. Custom code: the package has no option for it.
 */
const unvalidated = (schema: AiTask['schema']): AiSchema => ({
  '~standard': {
    ...schema['~standard'],
    validate: (value: unknown) => ({ value }),
  },
});

/**
 * The user message: the record as data between tags. JSON escapes quotes and
 * the angle brackets are escaped too, so the content cannot close the tag
 * and pass for instructions; the system prompt says what it is.
 */
const framePrompt = (
  task: AiTask,
  content: { title: string; fields: Record<string, unknown> },
) =>
  `Task: ${task.description}\n<record>\n${JSON.stringify({
    title: content.title,
    fields: content.fields,
  }).replaceAll('<', '\\u003c')}\n</record>`;

const view = (
  row: AiRunRow,
  output: Record<string, unknown> | null,
): AiRunView => ({
  id: row.id,
  source: row.source,
  subject: row.subject,
  recordId: row.recordId,
  task: row.task,
  promptVersion: row.promptVersion,
  model: row.model,
  status: row.status,
  output,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cached: row.cached,
  error: row.error ? t(`ai.errors.${row.error}`) : null,
  errorCode: row.error,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
