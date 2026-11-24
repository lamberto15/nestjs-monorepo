import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WorkflowClient, WorkflowNotFoundError } from '@nestjs/workflows';
import type { DatabaseTransactions } from '../../core/database/database.js';
import {
  defineEvent,
  Events,
  OnDomainEvent,
} from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import {
  TENANT_EVENTS,
  type TenantErasingEvent,
} from '../../iam/tenants/tenants.events.js';
import { approvalWorkflowId } from './approvals.events.js';
import { ApprovalsRepository } from './approvals.repository.js';

/** The requests of an erased tenant whose workflows may not have ended: theirs go after the commit. */
export const approvalWorkflowsOrphaned = defineEvent<{ requestIds: string[] }>(
  'approval.workflows-orphaned',
);

/**
 * An erased tenant's approval workflows go with it. A workflow waiting on a
 * person never ends on its own (no decision comes once the tenant is gone),
 * so the erase names the requests whose outcome was not applied yet (the
 * only ones whose workflow may still run: `outcomeAppliedAt` is set by the
 * last step) and their instances are deleted once the erase commits (the
 * outbox): an erase that rolls back keeps them. Finished instances go with
 * the workflows' retention (core/workflows).
 */
@Injectable()
export class ApprovalsErasure {
  constructor(
    private readonly repository: ApprovalsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly events: Events,
    private readonly workflows: WorkflowClient,
  ) {}

  /**
   * In TenantsService.purge()'s transaction, outside any tenant, before the
   * tenant's row goes; an error stops the erase. Its rows are read in the
   * tenant, outside that transaction (a tenant's rows are seen only in its
   * scope): the purge holds the tenant's row locked, so no request of it is
   * added meanwhile.
   */
  @OnEvent(TENANT_EVENTS.erasing, { suppressErrors: false })
  async tenantErasing({ tenantId }: TenantErasingEvent) {
    const open = await this.txHost.withoutTransaction(() =>
      this.tenancy.run(tenantId, () => this.repository.unapplied()),
    );
    if (open.length === 0) return;
    await this.events.publish(
      approvalWorkflowsOrphaned,
      { requestIds: open.map(({ id }) => id) },
      { key: tenantId },
    );
  }

  /** After the commit, in the worker. Safe to run again: an instance already gone is skipped. */
  @OnDomainEvent(approvalWorkflowsOrphaned, {
    consumer: 'approvals.delete-orphaned-workflows',
  })
  async deleteOrphaned({ requestIds }: { requestIds: string[] }) {
    for (const requestId of requestIds) {
      try {
        // Without compensating: what they would undo was erased with the tenant.
        await this.workflows.delete(approvalWorkflowId(requestId), {
          force: true,
        });
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
    }
  }
}
