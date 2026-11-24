import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { assertUnchanged, untagged } from '../../core/http/etag.js';
import { currentTenantScope } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../audit/audit.service.js';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import { AccessService } from './access.service.js';
import { type Role, RolesRepository } from './roles.repository.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ALL, isAll, type PermissionInput } from './permissions.js';

/** The built-in role's key: `all.manage`, never edited nor deleted. */
export const ADMINISTRATOR_ROLE = 'administrator';

export interface RoleInput {
  name: string;
  description?: string;
  permissions: PermissionInput[];
}

// Where it was first written: the repositories of other modules import it from here.
export { liveGrant } from './access.tables.js';

/** A role's name taken: 409. */
const nameTaken = (error: unknown) => {
  throw databaseErrorKind(error) === 'unique_violation'
    ? new ConflictException({
        code: 'role_name_taken',
        message: 'A role with this name already exists.',
      })
    : error;
};

/**
 * The tenant's roles, and the rules that keep access control safe:
 *
 * - Nobody grants what they can't do: a permission goes into a role, and a
 *   role to someone, only from a user who holds that action without
 *   conditions (and the fields it grants); administrators hold everything.
 *   Taking a permission out of a role (replacing or deleting it) is the
 *   same rule.
 * - The built-in Administrator role is never edited nor deleted, and only
 *   an administrator gives it.
 * - The last active administrator stays.
 *
 * Every change is audited in its transaction and drops the cached
 * abilities, so it applies from the next request.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly repository: RolesRepository,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly access: AccessService,
    private readonly catalog: PermissionCatalog,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return this.views(await this.repository.list());
  }

  /** One role of the tenant, as the list shows it (another tenant's is a 404). */
  async get(id: string) {
    return (await this.views([await this.find(id)]))[0]!;
  }

  async create(actor: UserPrincipal, input: RoleInput, ip?: string) {
    const permissions = await this.checkGrant(actor, input.permissions);
    const id = await this.txHost
      .withTransaction(async () => {
        const roleId = await this.repository.insert({
          name: input.name,
          description: input.description ?? '',
        });
        await this.writePermissions(roleId, permissions);
        await this.audit.record(actor, {
          action: 'role.created',
          targetType: 'role',
          targetId: roleId,
          details: { name: input.name, permissions },
          ip,
        });
        return roleId;
      })
      .catch(nameTaken);
    this.access.invalidate(currentTenantScope()?.tenantId ?? null);
    return { id };
  }

  /**
   * Replaces a role's name, description and permissions. `ifMatch` is
   * compared with the role as GET shows it, under its lock, so two
   * administrators can't both save over one version.
   */
  async update(
    actor: UserPrincipal,
    id: string,
    input: RoleInput,
    ip?: string,
    ifMatch?: string,
  ) {
    const role = await this.find(id);
    if (role.system) {
      throw new ConflictException(
        'The built-in Administrator role can’t be changed.',
      );
    }
    const permissions = await this.checkGrant(actor, input.permissions);
    await this.txHost
      .withTransaction(async () => {
        await this.lock(id, ifMatch);
        // Replacing takes the old permissions away: read under the lock.
        await this.checkTakeAway(actor, id);
        await this.repository.update(id, {
          name: input.name,
          description: input.description ?? '',
        });
        await this.repository.deletePermissions(id);
        await this.writePermissions(id, permissions);
        await this.audit.record(actor, {
          action: 'role.updated',
          targetType: 'role',
          targetId: id,
          details: { name: input.name, permissions },
          ip,
        });
      })
      .catch(nameTaken);
    this.access.invalidate(currentTenantScope()?.tenantId ?? null);
  }

  async remove(
    actor: UserPrincipal,
    id: string,
    ip?: string,
    ifMatch?: string,
  ) {
    const role = await this.find(id);
    if (role.system) {
      throw new ConflictException(
        'The built-in Administrator role can’t be deleted.',
      );
    }
    await this.txHost.withTransaction(async () => {
      await this.lock(id, ifMatch);
      await this.checkTakeAway(actor, id);
      await this.repository.delete(id);
      await this.audit.record(actor, {
        action: 'role.deleted',
        targetType: 'role',
        targetId: id,
        details: { name: role.name },
        ip,
      });
    });
    this.access.invalidate(currentTenantScope()?.tenantId ?? null);
  }

  /**
   * The roles a new tenant starts with, in the current tenant: the
   * built-in Administrator and the declared seed roles, named in the
   * default language. For whoever makes a tenant (the first-boot seed,
   * the tenants module), in its transaction.
   */
  async seedTenantRoles() {
    const administrator = this.catalog.seedRoleTexts(ADMINISTRATOR_ROLE);
    const adminId = await this.repository.insert({
      key: ADMINISTRATOR_ROLE,
      system: true,
      ...administrator,
    });
    await this.writePermissions(adminId, [ALL]);
    for (const seed of this.catalog.seedRoles) {
      const roleId = await this.repository.insert({
        key: seed.key,
        ...this.catalog.seedRoleTexts(seed.key),
      });
      await this.writePermissions(roleId, seed.permissions);
    }
    return { administratorId: adminId };
  }

  /** The keys of the declared seed roles, in order. */
  seedRoleKeys() {
    return this.catalog.seedRoles.map((role) => role.key);
  }

  /**
   * Validates permissions against the catalog (400) and checks the actor
   * may grant each (403): they hold it without conditions, on every field
   * it grants. Returns them normalized.
   */
  async checkGrant(actor: Principal, permissions: PermissionInput[]) {
    const own = await this.access.permissions(actor);
    const isAdmin = own.some(isAll);
    const valid: PermissionInput[] = [];
    for (const permission of permissions) {
      if (isAll(permission)) {
        if (!isAdmin) {
          throw new ForbiddenException(
            'Only an administrator grants everything.',
          );
        }
        valid.push(ALL);
        continue;
      }
      const result = this.catalog.validate(permission);
      if (!result.ok) {
        throw new BadRequestException(result.error);
      }
      const granted = result.value.fields;
      const holds =
        isAdmin ||
        own.some(
          (mine) =>
            mine.subject === permission.subject &&
            mine.action === permission.action &&
            mine.conditions.length === 0 &&
            // Your own permission covers the fields: all of them, or these.
            (!mine.fields ||
              (!!granted &&
                granted.every((field) => mine.fields!.includes(field)))),
        );
      if (!holds) {
        throw new ForbiddenException(
          `You can’t grant ${permission.subject}.${permission.action}${granted ? ` on ${granted.join(', ')}` : ''}: you don’t hold it without conditions.`,
        );
      }
      valid.push(result.value);
    }
    return valid;
  }

  /**
   * Taking a role's permissions away (replacing or deleting it): the same
   * rule as granting them (403), so nobody strips a stronger role of what
   * they don't hold. One the catalog no longer declares grants nothing:
   * anyone who may edit the role may drop it. Under the role's lock.
   */
  private async checkTakeAway(actor: Principal, roleId: string) {
    const held = await this.permissionsOf([roleId]);
    await this.checkGrant(
      actor,
      held.filter(
        (permission) =>
          isAll(permission) || this.catalog.validate(permission).ok,
      ),
    );
  }

  /** The roles exist in this tenant (400 otherwise) and the actor may grant each (403). */
  async checkRoleGrant(actor: Principal, roleIds: readonly string[]) {
    if (!roleIds.length) return;
    const found = await this.repository.existingIds([...roleIds]);
    if (found.length !== new Set(roleIds).size) {
      throw new BadRequestException('Unknown role.');
    }
    await this.checkGrant(actor, await this.permissionsOf(roleIds));
  }

  /**
   * You may act on someone (their roles, activation, units) only if you
   * hold, without conditions, every permission they hold: nobody gains
   * rights through another account. 403 `authority_required`.
   */
  async assertAuthorityOver(actor: UserPrincipal, userId: string, who: string) {
    if (userId === actor.id) return;
    const held = await this.repository.roleIdsOfUser(userId);
    try {
      // Ended grants too: the stricter answer.
      await this.checkGrant(actor, await this.permissionsOf(held));
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof BadRequestException
      ) {
        throw new ForbiddenException({
          code: 'authority_required',
          message: `You can’t act on ${who}: they hold permissions you don’t.`,
        });
      }
      throw error;
    }
  }

  /** In the caller's transaction: the tenant keeps at least one active administrator (409 otherwise). */
  async assertAnAdministratorRemains() {
    // One at a time: two administrators demoting each other at once can't
    // both see "one left". The built-in role's row is the lock.
    await this.repository.lockByKey(ADMINISTRATOR_ROLE);
    if (!(await this.repository.countActiveAdministrators())) {
      throw new ConflictException(
        'At least one active administrator must remain.',
      );
    }
  }

  /** The permissions of these roles. */
  async permissionsOf(roleIds: readonly string[]): Promise<PermissionInput[]> {
    if (!roleIds.length) return [];
    return this.repository.permissionsOf([...roleIds]);
  }

  /** Roles with their permissions and how many hold them (grants still running). */
  private async views(rows: Role[]) {
    const ids = rows.map((role) => role.id);
    if (!ids.length) return [];
    // One after the other: get() runs in the write's transaction (one connection).
    const permissions = await this.repository.permissionRowsOf(ids);
    const members = await this.repository.memberCounts(ids);
    return rows.map((role) =>
      // The ETag is the role's definition: a grant to someone (`members`)
      // doesn't make an editor's If-Match stale.
      untagged(
        {
          ...role,
          permissions: permissions
            .filter((permission) => permission.roleId === role.id)
            .map(({ subject, action, conditions, fields }) => ({
              subject,
              action,
              conditions,
              ...(fields && { fields }),
            })),
          members: members.find((row) => row.roleId === role.id)?.members ?? 0,
        },
        ['members'],
      ),
    );
  }

  private async find(id: string) {
    const role = await this.repository.findById(id);
    if (!role) {
      throw new NotFoundException(`Role ${id} not found.`);
    }
    return role;
  }

  /** Locks the role until the transaction ends, and compares `ifMatch` with the role as GET shows it. */
  private async lock(id: string, ifMatch?: string) {
    await this.repository.lock(id);
    if (ifMatch) assertUnchanged(ifMatch, await this.get(id));
  }

  private async writePermissions(
    roleId: string,
    permissions: PermissionInput[],
  ) {
    if (permissions.length) {
      await this.repository.insertPermissions(roleId, permissions);
    }
  }
}
