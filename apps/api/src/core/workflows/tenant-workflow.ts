import type { WorkflowContext, WorkflowRunner } from '@nestjs/workflows';
import { inTenantOf, type TenantEnvelope } from '../tenancy/tenant-job.js';

/**
 * A workflow whose steps run in the tenant that started it: the input
 * carries `tenantId` (start it with `withTenant(input)`, inside the
 * transaction that wrote the rows it acts on), and `run()` restores it
 * before `execute()`, so every step and every query in it is bound to that tenant.
 *
 * ```ts
 * @Workflow('note-publication')
 * export class NotePublication extends TenantWorkflow<{ noteId: string }> {
 *   async execute(ctx: WorkflowContext, input: { noteId: string }) { … }
 * }
 * ```
 *
 * The one base class: the engine calls `run(ctx, input)`, and nothing in
 * the package restores a context around it. A workflow of no tenant implements
 * WorkflowRunner itself.
 */
export abstract class TenantWorkflow<
  I extends object = object,
  O = unknown,
> implements WorkflowRunner<I & TenantEnvelope, O> {
  run(ctx: WorkflowContext, input: I & TenantEnvelope): Promise<O> {
    return inTenantOf(input, () => this.execute(ctx, input));
  }

  abstract execute(ctx: WorkflowContext, input: I & TenantEnvelope): Promise<O>;
}
