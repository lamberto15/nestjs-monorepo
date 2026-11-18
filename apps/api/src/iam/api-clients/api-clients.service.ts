import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { Events } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../access/access.service.js';
import { apiClientRoles } from '../access/access.tables.js';
import { regrant } from '../access/members.service.js';
import { liveGrant, RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { apiKeyId, generateApiKey, hashApiKey } from '../auth/api-keys.js';
import { apiClients, apiKeys } from '../auth/auth.tables.js';
import { normalizeCidr } from '../auth/client-ip.js';
import type { UserPrincipal } from '../auth/principal.js';
import {
  API_CLIENT_EVENTS,
  apiKeyRotated,
  type ClientRevokedEvent,
  type KeysRevokedEvent,
} from './api-clients.events.js';

export interface ClientInput {
  name: string;
  allowedCidrs?: string[];
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
  keyExpiresAt?: string;
}

export interface ClientChanges {
  active?: boolean;
  allowedCidrs?: string[];
  roleIds?: string[];
  roleExpiresAt?: Record<string, string>;
}

/**
 * The systems that call the API with a key. A key is shown once, when it is
 * made; only its public id and SHA-256 are stored (iam/auth/api-keys.ts). A
 * client may hold several keys: a rotation makes a new one and keeps the old
 * ones working for a grace period, so the system switches without downtime.
 * Keys can expire, are revoked one by one, and record when they were last
 * used (iam/auth). Every change is audited in its transaction; what ends
 * with a client or its keys (live connections) is announced after the
 * commit (api-clients.events.ts).
 */
@Injectable()
export class ApiClientsService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly events: EventEmitter2,
    // The outbox, when booted (always in the app): the rotation's domain event.
    @Optional() private readonly domainEvents?: Events,
  ) {}

  async list() {
    const clients = await this.db
      .select()
      .from(apiClients)
      .orderBy(asc(apiClients.name));
    return this.views(clients);
  }

  /** One client of the tenant, never its keys' secrets; another tenant's is a 404. */
  async get(id: string) {
    return (await this.views([await this.find(id)]))[0]!;
  }

  /** A client and its first key, shown this once. */
  async create(actor: UserPrincipal, input: ClientInput, ip?: string) {
    const roleIds = [...new Set(input.roleIds ?? [])];
    await this.roles.checkRoleGrant(actor, roleIds);
    const { expiries } = regrant(new Map(), roleIds, input.roleExpiresAt);
    const allowedCidrs = normalizeCidrs(input.allowedCidrs ?? []);
    const { id, key } = await this.txHost.withTransaction(async () => {
      const [client] = await this.db
        .insert(apiClients)
        .values({ name: input.name, allowedCidrs })
        .returning()
        .catch(nameTaken);
      const created = await this.addKey(client!.id, input.keyExpiresAt);
      await this.writeRoles(client!.id, roleIds, expiries);
      await this.audit.record(actor, {
        action: 'client.created',
        targetType: 'client',
        targetId: client!.id,
        details: {
          name: client!.name,
          keyId: apiKeyId(created),
          roleIds,
          ...(allowedCidrs.length > 0 && { allowedCidrs }),
        },
        ip,
      });
      return { id: client!.id, key: created };
    });
    this.access.invalidate();
    return { ...(await this.get(id)), key };
  }

  /** Revokes or reactivates a client, replaces its allowlist and roles. */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: ClientChanges,
    ip?: string,
  ) {
    const before = await this.find(id);
    await this.assertAuthorityOver(actor, id, before.name);
    const current = await this.liveGrantsOf(id);
    const grants =
      changes.roleIds &&
      regrant(current, changes.roleIds, changes.roleExpiresAt);
    if (grants) {
      await this.roles.checkRoleGrant(actor, grants.changed);
    }
    const allowedCidrs =
      changes.allowedCidrs && normalizeCidrs(changes.allowedCidrs);
    await this.txHost.withTransaction(async () => {
      if (changes.active !== undefined && changes.active !== before.active) {
        await this.db
          .update(apiClients)
          .set({ active: changes.active })
          .where(eq(apiClients.id, id));
        await this.audit.record(actor, {
          action: changes.active ? 'client.activated' : 'client.revoked',
          targetType: 'client',
          targetId: id,
          details: { name: before.name },
          ip,
        });
      }
      if (allowedCidrs && allowedCidrs.join() !== before.allowedCidrs.join()) {
        await this.db
          .update(apiClients)
          .set({ allowedCidrs })
          .where(eq(apiClients.id, id));
        await this.audit.record(actor, {
          action: 'client.allowlist-changed',
          targetType: 'client',
          targetId: id,
          details: {
            allowedCidrs: { from: before.allowedCidrs, to: allowedCidrs },
          },
          ip,
        });
      }
      if (changes.roleIds && grants) {
        // Ended grants not given again are deleted here, never rewritten.
        await this.db
          .delete(apiClientRoles)
          .where(eq(apiClientRoles.clientId, id));
        await this.writeRoles(id, changes.roleIds, grants.expiries);
        await this.audit.record(actor, {
          action: 'client.roles-changed',
          targetType: 'client',
          targetId: id,
          details: {
            roleIds: { from: [...current.keys()], to: changes.roleIds },
            ...(changes.roleExpiresAt && {
              roleExpiresAt: changes.roleExpiresAt,
            }),
          },
          ip,
        });
      }
    });
    this.access.invalidate();
    if (changes.active === false && before.active) {
      await this.announceRevoked(id);
    }
    return this.get(id);
  }

  /**
   * Deletes a client for good (revoking is `active: false`): its keys and
   * role grants go with the row; the audit entry keeps its name.
   */
  async remove(actor: UserPrincipal, id: string, ip?: string) {
    const client = await this.find(id);
    await this.assertAuthorityOver(actor, id, client.name);
    await this.txHost.withTransaction(async () => {
      await this.db.delete(apiClients).where(eq(apiClients.id, id));
      await this.audit.record(actor, {
        action: 'client.deleted',
        targetType: 'client',
        targetId: id,
        details: { name: client.name },
        ip,
      });
    });
    this.access.invalidate();
    await this.announceRevoked(id);
  }

  /**
   * A new key; the client's current keys stop working after `graceSeconds`
   * (0: now). Returns the client with the new key, shown this once.
   */
  async rotate(
    actor: UserPrincipal,
    id: string,
    options: { graceSeconds: number; expiresAt?: string },
    ip?: string,
  ) {
    const client = await this.find(id);
    await this.assertAuthorityOver(actor, id, client.name);
    const now = new Date();
    const until = new Date(now.getTime() + options.graceSeconds * 1000);
    const { key, ended } = await this.txHost.withTransaction(async () => {
      // Current keys end at the grace period's end (or sooner, if they expire earlier).
      const rows = await this.db
        .update(apiKeys)
        .set(
          options.graceSeconds === 0
            ? { revokedAt: now }
            : { expiresAt: until },
        )
        .where(
          and(
            // api_keys is global (found by its id before the tenant is known):
            // this tenant's keys only, said here.
            eq(apiKeys.tenantId, this.tenancy.tenantId()),
            eq(apiKeys.clientId, id),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, until)),
          ),
        )
        .returning({ keyId: apiKeys.keyId });
      const created = await this.addKey(id, options.expiresAt);
      await this.audit.record(actor, {
        action: 'client.key-rotated',
        targetType: 'client',
        targetId: id,
        details: {
          name: client.name,
          keyId: apiKeyId(created),
          previousKeysEnd: until.toISOString(),
        },
        ip,
      });
      await this.domainEvents?.publish(
        apiKeyRotated,
        {
          clientId: id,
          keyId: apiKeyId(created),
          previousKeysEnd: until.toISOString(),
        },
        { key: id },
      );
      return { key: created, ended: rows.map((row) => row.keyId) };
    });
    if (options.graceSeconds === 0) await this.announceKeys(ended);
    return { ...(await this.get(id)), key };
  }

  /** Stops one key now. */
  async revokeKey(
    actor: UserPrincipal,
    clientId: string,
    keyId: string,
    ip?: string,
  ) {
    const client = await this.find(clientId);
    await this.assertAuthorityOver(actor, clientId, client.name);
    const revoked = await this.txHost.withTransaction(async () => {
      const [row] = await this.db
        .update(apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(apiKeys.tenantId, this.tenancy.tenantId()),
            eq(apiKeys.clientId, clientId),
            eq(apiKeys.id, keyId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ keyId: apiKeys.keyId });
      if (!row) {
        throw new NotFoundException(`Key ${keyId} not found.`);
      }
      await this.audit.record(actor, {
        action: 'client.key-revoked',
        targetType: 'client',
        targetId: clientId,
        details: { keyId: row.keyId },
        ip,
      });
      return row.keyId;
    });
    await this.announceKeys([revoked]);
  }

  /** After the commit: the sockets of these keys end (modules/realtime). */
  private async announceKeys(keyIds: string[]) {
    if (keyIds.length === 0) return;
    await this.events.emitAsync(API_CLIENT_EVENTS.keysRevoked, {
      keyIds,
    } satisfies KeysRevokedEvent);
  }

  private async announceRevoked(clientId: string) {
    await this.events.emitAsync(API_CLIENT_EVENTS.revoked, {
      clientId,
      tenantId: this.tenancy.tenantId(),
    } satisfies ClientRevokedEvent);
  }

  private async find(id: string) {
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    if (!client) {
      throw new NotFoundException(`API client ${id} not found.`);
    }
    return client;
  }

  /**
   * You may act on a client (its roles, keys, activation, deletion) only if
   * you hold, without conditions, every permission it holds: nobody gains
   * rights through a key. 403 `authority_required`. Public: a module that
   * acts on a client's behalf (usage) asks the same rule.
   */
  async assertAuthorityOver(
    actor: UserPrincipal,
    clientId: string,
    who: string,
  ) {
    // Ended grants too: the stricter answer.
    const held = await this.db
      .select({ roleId: apiClientRoles.roleId })
      .from(apiClientRoles)
      .where(eq(apiClientRoles.clientId, clientId));
    try {
      await this.roles.checkGrant(
        actor,
        await this.roles.permissionsOf(held.map((row) => row.roleId)),
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw new ForbiddenException({
          code: 'authority_required',
          message: `You can’t act on ${who}: it holds permissions you don’t.`,
        });
      }
      throw error;
    }
  }

  private async addKey(clientId: string, expiresAt?: string) {
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
      throw new BadRequestException('A key can’t end in the past.');
    }
    const key = generateApiKey();
    await this.db.insert(apiKeys).values({
      // The client's tenant: a key is found by its id before any tenant.
      tenantId: this.tenancy.tenantId(),
      clientId,
      keyId: apiKeyId(key)!,
      keyHash: hashApiKey(key),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
    return key;
  }

  /** A client's grants still running: role id → end (null: never). */
  private async liveGrantsOf(clientId: string) {
    const rows = await this.db
      .select({
        roleId: apiClientRoles.roleId,
        expiresAt: apiClientRoles.expiresAt,
      })
      .from(apiClientRoles)
      .where(
        and(eq(apiClientRoles.clientId, clientId), liveGrant(apiClientRoles)),
      );
    return new Map(rows.map((row) => [row.roleId, row.expiresAt]));
  }

  /** A client's role grants, each with its end; a kept end that passed meanwhile isn't written. */
  private async writeRoles(
    clientId: string,
    roleIds: string[],
    expiresAt: Record<string, string>,
  ) {
    const now = Date.now();
    const end = (roleId: string) =>
      expiresAt[roleId] ? new Date(expiresAt[roleId]) : null;
    const unique = [...new Set(roleIds)].filter(
      (roleId) => (end(roleId)?.getTime() ?? Infinity) > now,
    );
    if (unique.length) {
      await this.db.insert(apiClientRoles).values(
        unique.map((roleId) => ({
          clientId,
          roleId,
          expiresAt: end(roleId),
        })),
      );
    }
  }

  /** Clients as the routes show them: their keys (never the secrets) and live role grants. */
  private async views(clients: (typeof apiClients.$inferSelect)[]) {
    const ids = clients.map((client) => client.id);
    if (!ids.length) return [];
    // One after the other: get() may run in a write's transaction (one connection).
    const keys = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, this.tenancy.tenantId()),
          inArray(apiKeys.clientId, ids),
        ),
      )
      .orderBy(asc(apiKeys.createdAt));
    // An ended grant is gone: never reported, so never echoed back into a change.
    const grants = await this.db
      .select()
      .from(apiClientRoles)
      .where(
        and(inArray(apiClientRoles.clientId, ids), liveGrant(apiClientRoles)),
      );
    return clients.map((client) => ({
      id: client.id,
      name: client.name,
      active: client.active,
      allowedCidrs: client.allowedCidrs,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
      keys: keys
        .filter((key) => key.clientId === client.id)
        .map(({ id, keyId, createdAt, expiresAt, revokedAt, lastUsedAt }) => ({
          id,
          keyId,
          createdAt,
          expiresAt,
          revokedAt,
          lastUsedAt,
        })),
      roles: grants
        .filter((grant) => grant.clientId === client.id)
        .map(({ roleId, expiresAt }) => ({ roleId, expiresAt })),
    }));
  }
}

/** CIDRs in canonical form, duplicates dropped; a malformed one is a 400 `invalid_cidr`. */
function normalizeCidrs(cidrs: string[]) {
  const normalized = cidrs.map((cidr) => {
    const result = normalizeCidr(cidr);
    if (typeof result !== 'string') {
      throw new BadRequestException({
        code: 'invalid_cidr',
        message: result.error,
      });
    }
    return result;
  });
  return [...new Set(normalized)];
}

/** A name taken: 409. */
const nameTaken = (error: unknown): never => {
  throw databaseErrorKind(error) === 'unique_violation'
    ? new ConflictException({
        code: 'client_name_taken',
        message: 'An API client with this name exists.',
      })
    : error;
};
