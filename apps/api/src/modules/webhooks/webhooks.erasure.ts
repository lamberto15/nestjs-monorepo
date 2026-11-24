import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
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
import { WebhooksRepository } from './webhooks.repository.js';
import { WebhooksService } from './webhooks.service.js';

/** The API clients of an erased tenant: their endpoints go after the commit. */
export const webhookClientsErased = defineEvent<{ clientIds: string[] }>(
  'webhook.clients-erased',
);

/**
 * An erased tenant's endpoints go with it. They live in the package's
 * store (nest_webhooks, keyed by client), which the tenant's cascade
 * doesn't reach: left there, its pending deliveries would keep sending the
 * tenant's data, and its URLs and secrets would stay.
 */
@Injectable()
export class WebhooksErasure {
  constructor(
    private readonly repository: WebhooksRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly events: Events,
    private readonly webhooks: WebhooksService,
  ) {}

  /**
   * In TenantsService.purge()'s transaction, before the tenant's row goes;
   * an error stops the erase. The clients are read in the tenant, outside
   * that transaction (a tenant's rows are seen only in its scope); the
   * endpoints are deleted once the erase commits, so one rolled back keeps them.
   */
  @OnEvent(TENANT_EVENTS.erasing, { suppressErrors: false })
  async tenantErasing({ tenantId }: TenantErasingEvent) {
    const clientIds = await this.txHost.withoutTransaction(() =>
      this.tenancy.run(tenantId, () => this.repository.clientIds()),
    );
    if (clientIds.length === 0) return;
    await this.events.publish(
      webhookClientsErased,
      { clientIds },
      { key: tenantId },
    );
  }

  /** After the commit, in the worker. Safe to run again: a client without endpoints is skipped. */
  @OnDomainEvent(webhookClientsErased, {
    consumer: 'webhooks.delete-erased-endpoints',
  })
  async deleteErased({ clientIds }: { clientIds: string[] }) {
    for (const clientId of clientIds) {
      await this.webhooks.deleteEndpointsOf(clientId);
    }
  }
}
