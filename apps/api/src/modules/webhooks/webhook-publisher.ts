import { createHash } from 'node:crypto';
import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  NonRetryableMessageError,
  type OutboxHandlerContext,
} from '@nestjs/outbox';
import { type NewWebhookMessage, Webhooks } from '@nestjs/webhooks';
import { eq, inArray } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { EncryptionService } from '../../core/encryption/encryption.service.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import { AccessService } from '../../iam/access/access.service.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import type { ClientPrincipal } from '../../iam/auth/principal.js';
import type { WebhookEvent } from './webhook-events.js';
import { storeEndpoints } from './webhook-store.view.js';

/**
 * Turns a module's domain event into webhooks (`WebhooksModule.forFeature()`):
 * in the worker, in the event's tenant, one message per API client of that
 * tenant that has an endpoint and may `read` the event's subject with its
 * public `data` as the record, redacted to the fields the client may read.
 * The package fans each message out to the client's subscribed endpoints
 * after the commit. An event outside any tenant reaches no client.
 */
@Injectable()
export class WebhookPublisher {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly webhooks: Webhooks<Database>,
    private readonly access: AccessService,
    private readonly encryption: EncryptionService,
  ) {}

  async publish(
    definition: WebhookEvent,
    payload: unknown,
    ctx: OutboxHandlerContext,
  ) {
    const tenantId = currentTenantScope()?.tenantId;
    if (!tenantId) return;
    const type = definition.event.type;
    const parsed = definition.data.safeParse(
      this.encryption.withoutEncrypted(payload),
    );
    if (!parsed.success) {
      throw new NonRetryableMessageError(
        `The payload of ${type} doesn't match its webhook's data schema.`,
      );
    }
    const data = parsed.data as Record<string, unknown>;
    const messages: NewWebhookMessage[] = [];
    for (const client of await this.subscribers()) {
      const principal: ClientPrincipal = {
        kind: 'client',
        ...client,
        tenantId,
      };
      if (!(await this.access.can(principal, 'read', definition.subject, data)))
        continue;
      messages.push({
        type,
        tenant: client.id,
        data: await this.access.redact(
          principal,
          'read',
          definition.subject,
          data,
        ),
        // The same event to the same client is the same webhook-id, whatever retries.
        id: `msg_${createHash('sha256').update(`${ctx.message.id}:${client.id}`).digest('hex').slice(0, 32)}`,
      });
    }
    if (messages.length === 0) return;
    await this.txHost.withTransaction(() =>
      Promise.resolve(
        ctx.processInTransaction(this.txHost.tx, () =>
          this.webhooks.dispatch(this.txHost.tx, messages),
        ),
      ),
    );
    this.webhooks.notify();
  }

  /** The tenant's active API clients that have at least one endpoint. */
  private async subscribers() {
    const clients = await this.db
      .select({ id: apiClients.id, name: apiClients.name })
      .from(apiClients)
      .where(eq(apiClients.active, true));
    if (clients.length === 0) return [];
    const withEndpoints = await this.db
      .selectDistinct({ tenant: storeEndpoints.tenant })
      .from(storeEndpoints)
      .where(
        inArray(
          storeEndpoints.tenant,
          clients.map((client) => client.id),
        ),
      );
    const ids = new Set(withEndpoints.map((row) => row.tenant));
    return clients.filter((client) => ids.has(client.id));
  }
}
