import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import {
  currentTenantScope,
  inheritScope,
  NO_TENANT,
  TENANT_SCOPE,
  tenantScope,
} from './tenant-scope.js';

/**
 * What a job's data carries: the tenant it was queued in, `null` for work of
 * no tenant. Required by type, so a producer that forgets it doesn't
 * compile, and checked by the consumer, which refuses data without it.
 */
export interface TenantEnvelope {
  readonly tenantId: string | null;
}

/** The data with the current context's tenant (null without one): what a producer queues. */
export function withTenant<T extends object>(data: T): T & TenantEnvelope {
  return { ...data, tenantId: currentTenantScope()?.tenantId ?? null };
}

/**
 * Runs `work` in the tenant an envelope names, in a context of its own:
 * what a consumer does first. An envelope without the field (a job queued
 * by hand, or before tenancy) is refused rather than run with no tenant or
 * the wrong one.
 */
export function inTenantOf<T>(
  envelope: Partial<TenantEnvelope> | null | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const tenantId = envelope?.tenantId;
  if (tenantId === undefined) {
    return Promise.reject(
      new Error('The job carries no tenantId: queue withTenant(data).'),
    );
  }
  const scope = inheritScope(
    tenantId === null ? NO_TENANT : tenantScope(tenantId),
  );
  const cls = ClsServiceManager.getClsService();
  // Awaited inside: a query runs when awaited, in this context.
  return cls.run({ ifNested: 'inherit' }, async () => {
    cls.set(TENANT_SCOPE, scope);
    return await work();
  });
}

/**
 * A BullMQ consumer whose jobs run in the tenant that queued them:
 * `process()` restores it, then calls `handle()`. Producers queue
 * `withTenant(data)`.
 *
 * ```ts
 * @Processor('thumbnails')
 * export class ThumbnailProcessor extends TenantWorkerHost<{ fileKey: string }> {
 *   async handle(job: Job<{ fileKey: string } & TenantEnvelope>) { … }
 * }
 * ```
 */
export abstract class TenantWorkerHost<
  T extends object = object,
  R = unknown,
> extends WorkerHost {
  override process(job: Job<T & TenantEnvelope>, token?: string): Promise<R> {
    return inTenantOf(job.data, () => this.handle(job, token));
  }

  abstract handle(job: Job<T & TenantEnvelope>, token?: string): Promise<R>;
}
