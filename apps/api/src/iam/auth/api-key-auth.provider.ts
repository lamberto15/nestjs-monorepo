import { createHash } from 'node:crypto';
import {
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { ApiKeyProvider, AuthenticationRegistry } from '@nestjs/authentication';
import { InjectDrizzle } from '@nestjs/drizzle';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import type { NodeRequest as Request } from '@nestjs/platform-node';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '../../core/database/database.js';
import { REDIS } from '../../core/redis/redis.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { API_KEY_PREFIX } from './api-keys.js';
import { authConfig } from './auth.config.js';
import { AUTH_EVENTS, type ClientIpDeniedEvent } from './auth.events.js';
import { apiClients, apiKeys } from './auth.tables.js';
import { ipAllowed } from './client-ip.js';
import type { ClientPrincipal, RequestPrincipal } from './principal.js';

/** How often a key's last use is written: at most once a minute per key. */
const LAST_USED_EVERY_MS = 60_000;

/** A refusal is announced (and audited) once per client and address in this long. */
const DENIED_EVERY_SECONDS = 3600;

/**
 * API clients: `Authorization: Bearer <prefix>_<id>_<secret>`. The package
 * compares the key's SHA-256 with the stored one in constant time. A key
 * works while it isn't revoked or expired, its client is active and its
 * tenant too: each stops on its next request. Second in the chain (order 1).
 *
 * A client with `allowedCidrs` is served only from those addresses: the
 * address is the adapter's `req.ip`, so its trusted proxies decide which
 * X-Forwarded-For hops count (core/http/http-setup.ts); the header itself
 * is never read here. Otherwise 403 `client_ip_not_allowed`, announced
 * (`auth.client-ip-denied`, audited) once per address and hour.
 */
@Injectable()
export class ApiKeyAuth extends ApiKeyProvider<RequestPrincipal> {
  private readonly logger = new Logger('ApiKeys');
  /** The allowlist of the client findKey returned, read back by authenticate (the same object). */
  private readonly allowlists = new WeakMap<object, string[]>();

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
    private readonly tenancy: Tenancy,
    private readonly events: EventEmitter2,
    @Inject(REDIS) private readonly redis: Redis,
    registry: AuthenticationRegistry,
  ) {
    super({ prefix: API_KEY_PREFIX, realm: 'api' });
    registry.registerProvider(this, { order: 1 });
  }

  // The key (a global table) names its tenant; the client, a tenant table,
  // is read in that tenant's scope. A key of an inactive tenant stops.
  async findKey(id: string) {
    // API_CLIENTS=off: no key authenticates.
    if (!this.config.apiClients) {
      return null;
    }
    const [key] = await this.db
      .select({ key: apiKeys, tenantActive: tenants.active })
      .from(apiKeys)
      .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
      .where(eq(apiKeys.keyId, id));
    const now = new Date();
    if (
      !key?.tenantActive ||
      key.key.revokedAt ||
      (key.key.expiresAt && key.key.expiresAt <= now)
    ) {
      return null;
    }
    const [client] = await this.tenancy.run(key.key.tenantId, () =>
      this.db
        .select()
        .from(apiClients)
        .where(eq(apiClients.id, key.key.clientId)),
    );
    if (!client?.active) {
      return null;
    }
    const user: ClientPrincipal = {
      kind: 'client',
      id: client.id,
      name: client.name,
      tenantId: client.tenantId,
    };
    this.allowlists.set(user, client.allowedCidrs);
    // On the session too (ApiKeySession.expiresAt): a socket opened with
    // the key ends at it.
    return { hash: key.key.keyHash, user, expiresAt: key.key.expiresAt };
  }

  /** After the package verified the secret: check the address, record the use. */
  override async authenticate(context: ExecutionContext) {
    const result = await super.authenticate(context);
    if (result?.user) {
      await this.checkAddress(context, result.user);
    }
    if (result?.session?.keyId) {
      this.touch(result.session.keyId, new Date());
    }
    return result;
  }

  /** Refuses a request from outside the client's allowlist (after the secret is verified, so a wrong key learns nothing). */
  private async checkAddress(
    context: ExecutionContext,
    client: RequestPrincipal,
  ) {
    const cidrs = this.allowlists.get(client);
    const ip =
      context.getType() === 'http'
        ? context.switchToHttp().getRequest<Request>().ip
        : undefined;
    // A principal findKey didn't return has no known allowlist: refused, never waved through.
    if (cidrs !== undefined && ipAllowed(ip, cidrs)) {
      return;
    }
    if (client.kind === 'client') {
      await this.announceDenied(client, ip);
    }
    throw new ForbiddenException({
      code: 'client_ip_not_allowed',
      message: t('auth.clientIpNotAllowed'),
    });
  }

  /** Once per client and address an hour (Redis NX), so a flood doesn't fill the audit log. */
  private async announceDenied(
    client: ClientPrincipal,
    ip: string | undefined,
  ) {
    try {
      const key = `client-ip-denied:${client.id}:${createHash('sha256')
        .update(ip ?? '')
        .digest('hex')}`;
      const first = await this.redis.set(
        key,
        '1',
        'EX',
        DENIED_EVERY_SECONDS,
        'NX',
      );
      if (first === 'OK') {
        await this.events.emitAsync(AUTH_EVENTS.clientIpDenied, {
          client,
          ip,
        } satisfies ClientIpDeniedEvent);
      }
    } catch (error) {
      // The refusal stands even if it can't be recorded.
      this.logger.warn(`Refusal not recorded: ${(error as Error).message}`);
    }
  }

  /** Records the use, without making the request wait for it. */
  private touch(keyId: string, now: Date) {
    void this.db
      .update(apiKeys)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(apiKeys.keyId, keyId),
          or(
            isNull(apiKeys.lastUsedAt),
            lt(
              apiKeys.lastUsedAt,
              new Date(now.getTime() - LAST_USED_EVERY_MS),
            ),
          ),
        ),
      )
      .catch((error: Error) =>
        this.logger.warn(`Last use not recorded: ${error.message}`),
      );
  }
}
