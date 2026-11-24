import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, notExists } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { apiClientRoles } from '../../iam/access/access.tables.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import {
  DELIVERY_LIST,
  deliveryColumns,
  storeDeliveries,
  storeEndpoints,
} from './webhook-store.view.js';
import {
  webhookClientScopes,
  webhookDeliveryRequests,
  type WebhookScope,
} from './webhooks.tables.js';

/**
 * The outgoing webhooks' queries: the API clients they belong to, their
 * scope, and the deliveries and recorded requests read from the package's
 * store (webhook-store.view.ts). The transaction is the caller's (the
 * ambient one, `@InjectTransaction()`), and so is the tenant it runs in.
 */
@Injectable()
export class WebhooksRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async findClient(id: string) {
    const [client] = await this.db
      .select({ id: apiClients.id, name: apiClients.name })
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client;
  }

  /** Every role the client was granted, ended grants too. */
  async roleIdsOfClient(clientId: string) {
    const rows = await this.db
      .select({ roleId: apiClientRoles.roleId })
      .from(apiClientRoles)
      .where(eq(apiClientRoles.clientId, clientId));
    return rows.map((row) => row.roleId);
  }

  /** The tenant's API clients, ids only. */
  async clientIds() {
    const rows = await this.db.select({ id: apiClients.id }).from(apiClients);
    return rows.map((row) => row.id);
  }

  /** The tenant's active API clients that have at least one endpoint. */
  async subscribers() {
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

  async scopeOf(clientId: string): Promise<WebhookScope | undefined> {
    const [row] = await this.db
      .select({ scope: webhookClientScopes.scope })
      .from(webhookClientScopes)
      .where(eq(webhookClientScopes.clientId, clientId));
    return row?.scope;
  }

  /** The clients of this tenant whose scope is `tenant`. */
  async tenantScopedClientIds() {
    const rows = await this.db
      .select({ clientId: webhookClientScopes.clientId })
      .from(webhookClientScopes)
      .where(and(eq(webhookClientScopes.scope, 'tenant')));
    return new Set(rows.map((row) => row.clientId));
  }

  async saveScope(clientId: string, scope: WebhookScope) {
    await this.db
      .insert(webhookClientScopes)
      .values({ clientId, scope })
      .onConflictDoUpdate({
        target: [webhookClientScopes.tenantId, webhookClientScopes.clientId],
        set: { scope, updatedAt: new Date() },
      });
  }

  async deleteScope(clientId: string) {
    await this.db
      .delete(webhookClientScopes)
      .where(eq(webhookClientScopes.clientId, clientId));
  }

  /** The client's deliveries, newest first, cursor-paged (DELIVERY_LIST). */
  async deliveriesPage(clientId: string, query: ListQuery) {
    const mine = eq(storeDeliveries.tenant, clientId);
    const [rows, total] = await Promise.all([
      this.db
        .select({ ...deliveryColumns, ...DELIVERY_LIST.sortSelect(query) })
        .from(storeDeliveries)
        .where(and(mine, DELIVERY_LIST.where(query, storeDeliveries.id)))
        .orderBy(...pageOrder(storeDeliveries.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(
        this.db,
        storeDeliveries,
        and(mine, DELIVERY_LIST.where(query)),
        query,
      ),
    ]);
    return toPage(rows, query, total);
  }

  /** The request last sent for a delivery (webhook.transport.ts records it). */
  async lastRequestOf(deliveryId: string) {
    const [request] = await this.db
      .select()
      .from(webhookDeliveryRequests)
      .where(eq(webhookDeliveryRequests.deliveryId, deliveryId));
    return request;
  }

  /** The recorded requests whose delivery the package pruned: how many went. */
  async deleteOrphanRequests() {
    const deleted = await this.db
      .delete(webhookDeliveryRequests)
      .where(
        notExists(
          this.db
            .select({ id: storeDeliveries.id })
            .from(storeDeliveries)
            .where(eq(storeDeliveries.id, webhookDeliveryRequests.deliveryId)),
        ),
      )
      .returning({ id: webhookDeliveryRequests.deliveryId });
    return deleted.length;
  }
}
