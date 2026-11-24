import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { Events } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../access/access.service.js';
import { regrant } from '../access/members.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import { apiKeyId, generateApiKey, hashApiKey } from '../auth/api-keys.js';
import { normalizeCidr } from '../auth/client-ip.js';
import { discoverOne } from '../auth/discover.js';
import type { UserPrincipal } from '../auth/principal.js';
import {
  type ApiClient,
  ApiClientsRepository,
} from './api-clients.repository.js';
import { ClientQuota } from './client-quota.js';
import {
  API_CLIENT_EVENTS,
  apiClientDeleted,
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
  /** Set with the client by the usage module (ClientQuota). */
  dailyQuota?: number;
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
export class ApiClientsService implements OnModuleInit {
  constructor(
    private readonly repository: ApiClientsRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly events: EventEmitter2,
    private readonly discovery: DiscoveryService,
    // The outbox, when booted (always in the app): the rotation's domain event.
    @Optional() private readonly domainEvents?: Events,
  ) {}

  /** The usage module's quotas, when booted. */
  private quota?: ClientQuota;

  onModuleInit() {
    this.quota = discoverOne<ClientQuota>(
      this.discovery,
      ClientQuota,
      'client quota source (@ClientQuota())',
    );
  }

  async list() {
    return this.views(await this.repository.list());
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
    const quota = input.dailyQuota;
    if (quota !== undefined) {
      if (!this.quota) {
        throw new BadRequestException({
          code: 'validation_failed',
          message: 'The request is invalid.',
          errors: [
            { path: 'dailyQuota', message: 'Quotas are not enabled here.' },
          ],
        });
      }
      if (!(await this.quota.allowed(actor))) {
        throw new ForbiddenException('You may not set a client’s quota.');
      }
    }
    const { id, key } = await this.txHost.withTransaction(async () => {
      const client = await this.repository
        .insert({ name: input.name, allowedCidrs })
        .catch(nameTaken);
      const created = await this.addKey(client.id, input.keyExpiresAt);
      await this.writeRoles(client.id, roleIds, expiries);
      if (quota !== undefined) {
        await this.quota!.set(actor, client.id, quota, ip);
      }
      await this.audit.record(actor, {
        action: 'client.created',
        targetType: 'client',
        targetId: client.id,
        details: {
          name: client.name,
          keyId: apiKeyId(created),
          roleIds,
          ...(allowedCidrs.length > 0 && { allowedCidrs }),
        },
        ip,
      });
      return { id: client.id, key: created };
    });
    this.access.invalidate(this.tenancy.tenantId());
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
        await this.repository.update(id, { active: changes.active });
        await this.audit.record(actor, {
          action: changes.active ? 'client.activated' : 'client.revoked',
          targetType: 'client',
          targetId: id,
          details: { name: before.name },
          ip,
        });
      }
      if (allowedCidrs && allowedCidrs.join() !== before.allowedCidrs.join()) {
        await this.repository.update(id, { allowedCidrs });
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
        await this.repository.deleteGrants(id);
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
    this.access.invalidate(this.tenancy.tenantId());
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
      await this.repository.delete(id);
      await this.audit.record(actor, {
        action: 'client.deleted',
        targetType: 'client',
        targetId: id,
        details: { name: client.name },
        ip,
      });
      await this.domainEvents?.publish(
        apiClientDeleted,
        { clientId: id },
        { key: id },
      );
    });
    this.access.invalidate(this.tenancy.tenantId());
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
      const ended = await this.repository.endKeys(
        id,
        options.graceSeconds === 0 ? { revokedAt: now } : { expiresAt: until },
        until,
      );
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
      return { key: created, ended };
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
      const row = await this.repository.revokeKey(clientId, keyId);
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
    const client = await this.repository.findById(id);
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
    const held = await this.repository.roleIdsOf(clientId);
    try {
      await this.roles.checkGrant(actor, await this.roles.permissionsOf(held));
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
    await this.repository.insertKey({
      clientId,
      keyId: apiKeyId(key)!,
      keyHash: hashApiKey(key),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
    return key;
  }

  /** A client's grants still running: role id → end (null: never). */
  private async liveGrantsOf(clientId: string) {
    const rows = await this.repository.liveGrantsOf([clientId]);
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
      await this.repository.insertGrants(
        unique.map((roleId) => ({
          clientId,
          roleId,
          expiresAt: end(roleId),
        })),
      );
    }
  }

  /** Clients as the routes show them: their keys (never the secrets) and live role grants. */
  private async views(clients: ApiClient[]) {
    const ids = clients.map((client) => client.id);
    if (!ids.length) return [];
    // One after the other: get() may run in a write's transaction (one connection).
    const keys = await this.repository.keysOf(ids);
    // An ended grant is gone: never reported, so never echoed back into a change.
    const grants = await this.repository.liveGrantsOf(ids);
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
