import { randomUUIDv7 } from 'node:crypto';
import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import {
  WebhookDeliveries,
  type WebhookDelivery,
  WebhookEndpoints,
  type WebhookMessage,
  WebhooksStorage,
  WebhookWorker,
} from '@nestjs/webhooks';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  countPage,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { apiClientRoles } from '../../iam/access/access.tables.js';
import { RolesService } from '../../iam/access/roles.service.js';
import {
  API_CLIENT_EVENTS,
  type ClientRevokedEvent,
} from '../../iam/api-clients/api-clients.events.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { WebhookCatalog } from './webhook-catalog.js';
import { TEST_EVENT_TYPE } from './webhook-events.js';
import {
  DELIVERY_LIST,
  deliveryColumns,
  storeDeliveries,
} from './webhook-store.view.js';
import { destinationRefusal } from './webhook.transport.js';
import { webhooksConfig } from './webhooks.config.js';
import type {
  CreateEndpointDto,
  RetryDeliveriesDto,
  UpdateEndpointDto,
} from './webhooks.schemas.js';
import { webhookDeliveryRequests } from './webhooks.tables.js';

/** The delivery's times, which the package keeps in epoch milliseconds. */
const DELIVERY_TIMES = [
  'createdAt',
  'nextAttemptAt',
  'lastAttemptAt',
  'completedAt',
] as const;

const iso = (ms: number) => new Date(ms).toISOString();

/** A delivery with its times as ISO 8601, like the rest of the API; only the keys it has (`?fields=`). */
function deliveryView(delivery: object): Record<string, unknown> {
  const view: Record<string, unknown> = { ...delivery };
  for (const key of DELIVERY_TIMES) {
    if (typeof view[key] === 'number') view[key] = iso(view[key]);
  }
  return view;
}

/**
 * Whose webhooks a call manages: the API client itself (its key), or a
 * signed-in user on its behalf (`by`), whose changes are audited as
 * theirs, with the client as the target.
 */
export interface WebhookOwner {
  /** The API client: the package's tenant. */
  clientId: string;
  by?: { user: UserPrincipal; ip?: string };
}

/**
 * An API client's webhook endpoints and deliveries, behind both doors: the
 * client's own routes and a user's on its behalf. Every call goes to the
 * package with the client as its tenant, so another client's endpoint or
 * delivery is a 404 either way. The package keeps them in its own store, on
 * its own connection: an audit entry is written after its change
 * succeeded, not in one transaction with it.
 */
@Injectable()
export class WebhooksService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    @Inject(webhooksConfig.KEY)
    private readonly config: ConfigType<typeof webhooksConfig>,
    private readonly endpoints: WebhookEndpoints,
    private readonly deliveries: WebhookDeliveries,
    private readonly storage: WebhooksStorage,
    private readonly worker: WebhookWorker,
    private readonly catalog: WebhookCatalog,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
  ) {}

  /** GET /v1/webhook-event-types. */
  eventTypes() {
    return { items: this.catalog.groups() };
  }

  /**
   * The owner for a user acting on `clientId`: a client of the request's
   * tenant (another tenant's id is a 404), over which the user has
   * authority: they hold, without conditions, every permission the
   * client's roles give, since its webhooks carry what it may read (403
   * `authority_required`, as for its keys).
   */
  async delegated(
    user: UserPrincipal,
    clientId: string,
    ip?: string,
  ): Promise<WebhookOwner> {
    const [client] = await this.db
      .select({ id: apiClients.id, name: apiClients.name })
      .from(apiClients)
      .where(eq(apiClients.id, clientId));
    if (!client) {
      throw new NotFoundException(`API client ${clientId} not found.`);
    }
    // Ended grants too: the stricter answer.
    const held = await this.db
      .select({ roleId: apiClientRoles.roleId })
      .from(apiClientRoles)
      .where(eq(apiClientRoles.clientId, client.id));
    try {
      await this.roles.checkGrant(
        user,
        await this.roles.permissionsOf(held.map((row) => row.roleId)),
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw new ForbiddenException({
          code: 'authority_required',
          message: `You can’t act on ${client.name}: it holds permissions you don’t.`,
        });
      }
      throw error;
    }
    return { clientId: client.id, by: { user, ip } };
  }

  // Endpoints

  async createEndpoint(owner: WebhookOwner, dto: CreateEndpointDto) {
    await this.assertSubscribable(dto.url, dto.eventTypes);
    const endpoint = await this.endpoints.create({
      url: dto.url,
      eventTypes: dto.eventTypes,
      description: dto.description ?? null,
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-endpoint.created', {
      endpointId: endpoint.id,
      url: endpoint.url,
      eventTypes: endpoint.eventTypes,
    });
    return endpoint;
  }

  async listEndpoints(owner: WebhookOwner) {
    return { items: await this.endpoints.list({ tenant: owner.clientId }) };
  }

  async getEndpoint(owner: WebhookOwner, id: string) {
    const endpoint = await this.endpoints.get(id, { tenant: owner.clientId });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${id} not found.`);
    }
    return endpoint;
  }

  async updateEndpoint(
    owner: WebhookOwner,
    id: string,
    dto: UpdateEndpointDto,
  ) {
    await this.getEndpoint(owner, id);
    await this.assertSubscribable(dto.url, dto.eventTypes);
    const endpoint = await this.endpoints.update(id, dto, {
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-endpoint.updated', {
      endpointId: id,
      changed: Object.keys(dto),
    });
    return endpoint;
  }

  async deleteEndpoint(owner: WebhookOwner, id: string) {
    await this.endpoints.delete(id, { tenant: owner.clientId });
    await this.audited(owner, 'webhook-endpoint.deleted', { endpointId: id });
  }

  async rotateSecret(owner: WebhookOwner, id: string) {
    const secret = await this.endpoints.rotateSecret(id, {
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-endpoint.secret-rotated', {
      endpointId: id,
    });
    return { secret };
  }

  /**
   * Sends the reserved `webhook.test` event to this endpoint alone,
   * whatever it subscribed to, through the normal path: a message and a
   * delivery in the package's store, which the worker signs, sends and
   * retries as any other. The package's fan-out picks endpoints by
   * subscription, so the delivery is created here as the fan-out does (the
   * store contract's `createDeliveries()`), with ids shaped as the
   * package's own (`msg_`/`dlv_` and a UUIDv7 without dashes).
   */
  async sendTest(owner: WebhookOwner, id: string) {
    const endpoint = await this.getEndpoint(owner, id);
    const now = Date.now();
    const bare = () => randomUUIDv7().replaceAll('-', '');
    const message: WebhookMessage = {
      id: `msg_${bare()}`,
      type: TEST_EVENT_TYPE,
      tenant: owner.clientId,
      body: JSON.stringify({
        type: TEST_EVENT_TYPE,
        timestamp: iso(now),
        data: { endpointId: endpoint.id, test: true },
      }),
      createdAt: now,
    };
    const delivery: WebhookDelivery = {
      id: `dlv_${bare()}`,
      messageId: message.id,
      endpointId: endpoint.id,
      tenant: owner.clientId,
      type: TEST_EVENT_TYPE,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lastAttemptAt: null,
      lastStatusCode: null,
      lastError: null,
      failureReason: null,
      createdAt: now,
      completedAt: null,
    };
    await this.storage.deliveries.createDeliveries(message, [delivery]);
    this.worker.notify();
    await this.audited(owner, 'webhook-endpoint.tested', {
      endpointId: endpoint.id,
      deliveryId: delivery.id,
    });
    return deliveryView(delivery);
  }

  // Deliveries

  /** The client's deliveries, newest first, cursor-paged (DELIVERY_LIST). */
  async listDeliveries(owner: WebhookOwner, query: ListQuery) {
    const mine = eq(storeDeliveries.tenant, owner.clientId);
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
    const page = DELIVERY_LIST.pick(toPage(rows, query, total), query);
    return { ...page, items: page.items.map(deliveryView) };
  }

  /** One delivery: its message, every attempt, the time they took and the request last sent. */
  async getDelivery(owner: WebhookOwner, id: string) {
    const delivery = await this.deliveries.get(id, { tenant: owner.clientId });
    if (!delivery) {
      throw new NotFoundException(`Webhook delivery ${id} not found.`);
    }
    const [request] = await this.db
      .select()
      .from(webhookDeliveryRequests)
      .where(eq(webhookDeliveryRequests.deliveryId, delivery.id));
    return {
      ...deliveryView(delivery),
      message: {
        ...delivery.message,
        createdAt: iso(delivery.message.createdAt),
      },
      history: delivery.history.map((attempt) => ({
        ...attempt,
        at: iso(attempt.at),
      })),
      durationMs: delivery.history.reduce(
        (sum, attempt) => sum + attempt.durationMs,
        0,
      ),
      lastRequest: request
        ? {
            attempt: request.attempt,
            sentAt: request.sentAt.toISOString(),
            headers: request.headers,
            signedWith:
              request.signedWith?.map(({ createdAt, expiresAt }) => ({
                createdAt: iso(createdAt),
                expiresAt: expiresAt === null ? null : iso(expiresAt),
              })) ?? null,
          }
        : null,
    };
  }

  async retry(owner: WebhookOwner, id: string) {
    const retried = await this.deliveries.retry(id, {
      tenant: owner.clientId,
    });
    await this.audited(owner, 'webhook-delivery.retried', {
      deliveryId: id,
      retried,
    });
    return { retried };
  }

  async retryFailed(owner: WebhookOwner, dto: RetryDeliveriesDto) {
    const since = dto.since === undefined ? undefined : new Date(dto.since);
    const retried = await this.deliveries.retry(
      { endpointId: dto.endpointId, status: 'failed', since },
      { tenant: owner.clientId },
    );
    await this.audited(owner, 'webhook-delivery.retried', {
      endpointId: dto.endpointId ?? null,
      since: dto.since ?? null,
      retried,
    });
    return { retried };
  }

  /**
   * A deleted client's endpoints go with it: nothing more is sent to it (its
   * pending deliveries fail as `endpoint-deleted`; the log stays). The
   * event also comes for a deactivation, which keeps them: only a client
   * that no longer exists in its tenant loses its endpoints.
   */
  @OnEvent(API_CLIENT_EVENTS.revoked)
  async onClientRevoked({ clientId }: ClientRevokedEvent) {
    const [client] = await this.db
      .select({ id: apiClients.id })
      .from(apiClients)
      .where(eq(apiClients.id, clientId));
    if (client) return;
    for (;;) {
      const page = await this.endpoints.list({ tenant: clientId, limit: 100 });
      for (const endpoint of page) {
        await this.endpoints.delete(endpoint.id, { tenant: clientId });
      }
      if (page.length < 100) return;
    }
  }

  /**
   * An endpoint's URL and types, before the package sees them: every type is
   * one a module declared (or `*`), so the reserved test event is refused;
   * and the URL is no address the delivery rules refuse (checked again at
   * every delivery). The package then checks the URL's form itself.
   */
  private async assertSubscribable(
    url: string | undefined,
    eventTypes: readonly string[] | undefined,
  ) {
    const unknown = (eventTypes ?? []).filter(
      (type) => type !== '*' && !this.catalog.has(type),
    );
    if (unknown.length > 0) {
      throw new BadRequestException({
        code: 'webhooks_refused',
        message: `Unknown event types: ${unknown.join(', ')} (GET /v1/webhook-event-types).`,
      });
    }
    const refused = url && (await destinationRefusal(url, this.config));
    if (refused) {
      throw new BadRequestException({
        code: 'webhooks_refused',
        message: `The URL is refused: ${refused}.`,
      });
    }
  }

  /** A user's change on a client's behalf, audited as theirs; a client's own isn't. */
  private async audited(
    owner: WebhookOwner,
    action: string,
    details: Record<string, unknown>,
  ) {
    if (!owner.by) return;
    await this.audit.record(owner.by.user, {
      action,
      targetType: 'client',
      targetId: owner.clientId,
      details,
      ip: owner.by.ip,
    });
  }
}
