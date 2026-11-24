import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  countMatching,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { memberships, users } from '../auth/auth.tables.js';
import { discoverOne } from '../auth/discover.js';
import type { UserPrincipal } from '../auth/principal.js';
import {
  ACCESS_EVENTS,
  type MemberDeactivatedEvent,
  type MemberReactivatedEvent,
} from './access.events.js';
import { NO_MEMBERS, userList } from './access.lists.js';
import { AccessService } from './access.service.js';
import { rolePermissions, roles, userRoles } from './access.tables.js';
import { MemberAvatars } from './member-avatars.js';
import { liveGrant, RolesService } from './roles.service.js';
import { ScimMembers } from './scim-members.js';
import { UnitDirectory } from './unit-directory.js';

/** What an administrator changes of a membership: never the account (its name, its password). */
export interface MemberChanges {
  active?: boolean;
  roleIds?: string[];
  /** When grants end, by role id (temporary access). */
  roleExpiresAt?: Record<string, string>;
}

/** A member as the users routes show them. */
const memberColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  emailVerified: users.emailVerified,
  locale: users.locale,
  timezone: users.timezone,
  // The membership in this tenant and the account, together.
  active: sql<boolean>`(${users.active} and ${memberships.active})`,
  hasPassword: isNotNull(users.passwordHash),
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

/**
 * The tenant's members as access administration sees them: their
 * memberships (users are global; a member is one through a membership in
 * the tenant), role grants and units. Changes keep the rules of
 * RolesService: authority over the member, the grant rule on every role
 * given, taken or whose end moves, and an administrator left.
 */
@Injectable()
export class MembersService implements OnModuleInit {
  private units?: UnitDirectory;
  private scim?: ScimMembers;
  private avatars?: MemberAvatars;
  private list = userList(NO_MEMBERS);

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly tenancy: Tenancy,
    private readonly access: AccessService,
    private readonly roles: RolesService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly discovery: DiscoveryService,
  ) {}

  onModuleInit() {
    this.scim = discoverOne<ScimMembers>(
      this.discovery,
      ScimMembers,
      'SCIM members source (@ScimMembers())',
    );
    this.avatars = discoverOne<MemberAvatars>(
      this.discovery,
      MemberAvatars,
      'member avatars source (@MemberAvatars())',
    );
    this.units = discoverOne<UnitDirectory>(
      this.discovery,
      UnitDirectory,
      'unit directory (@UnitDirectory())',
    );
    if (this.units) {
      const units = this.units;
      this.list = userList((userId, unitIds) =>
        units.membersOf(userId, unitIds),
      );
    }
  }

  /** A page of the tenant's members, with their grants and units. */
  async page(query: ListQuery) {
    const where = and(this.ofTenant(), this.list.where(query));
    const [rows, total] = await Promise.all([
      this.db
        .select({ ...memberColumns, ...this.list.sortSelect(query) })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(and(this.ofTenant(), this.list.where(query, users.id)))
        .orderBy(...pageOrder(users.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(users)
          .innerJoin(memberships, eq(memberships.userId, users.id))
          .where(where),
        query,
      ),
    ]);
    const page = toPage(rows, query, total);
    return { ...page, items: await this.withGrants(page.items) };
  }

  /** One member of the tenant, as the list shows them; anyone else is a 404. */
  async get(id: string) {
    return (await this.withGrants([await this.find(id)]))[0]!;
  }

  /** A member of the tenant (name and address), or a 404. */
  async find(id: string) {
    const [member] = await this.db
      .select(memberColumns)
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(and(this.ofTenant(), eq(users.id, id)));
    if (!member) {
      throw new NotFoundException(`User ${id} not found.`);
    }
    return member;
  }

  /**
   * Changes a membership: its activation and its roles in this tenant.
   * A deactivation is announced (`access.member-deactivated`) in the
   * change's transaction, and again once committed
   * (`access.member-deactivation-committed`); a reactivation in the
   * transaction (`access.member-reactivated`).
   */
  async update(
    actor: UserPrincipal,
    id: string,
    changes: MemberChanges,
    ip?: string,
  ) {
    const tenantId = this.tenancy.tenantId();
    const before = await this.find(id);
    if (changes.active === false && id === actor.id) {
      throw new ConflictException('You can’t deactivate yourself.');
    }
    await this.roles.assertAuthorityOver(actor, id, before.email);
    const current = await this.liveGrantsOf(id);
    // On oneself too: every role given (an ended one sent back included),
    // taken away or with a moved end goes through the grant rule.
    const grants =
      changes.roleIds &&
      regrant(current, changes.roleIds, changes.roleExpiresAt);
    if (grants) {
      await this.roles.checkRoleGrant(actor, grants.changed);
    }
    let deactivated = false;
    await this.txHost.withTransaction(async () => {
      // One change to the membership at a time.
      const [membership] = await this.db
        .select({ active: memberships.active })
        .from(memberships)
        .where(and(this.ofTenant(), eq(memberships.userId, id)))
        .for('update');
      if (changes.active !== undefined) {
        await this.db
          .update(memberships)
          .set({ active: changes.active })
          .where(and(this.ofTenant(), eq(memberships.userId, id)));
      }
      if (changes.roleIds && grants) {
        // Ended grants not given again are deleted here, never rewritten.
        await this.db.delete(userRoles).where(eq(userRoles.userId, id));
        await this.writeRoles(id, changes.roleIds, grants.expiries);
      }
      await this.roles.assertAnAdministratorRemains();
      if (changes.active === false && membership?.active) {
        deactivated = true;
        await this.events.emitAsync(ACCESS_EVENTS.memberDeactivated, {
          userId: id,
          tenantId,
          actor,
        } satisfies MemberDeactivatedEvent);
      }
      if (changes.active === true && membership && !membership.active) {
        await this.events.emitAsync(ACCESS_EVENTS.memberReactivated, {
          userId: id,
          tenantId,
          actor,
          ip,
        } satisfies MemberReactivatedEvent);
      }
      await this.audit.record(actor, {
        action: 'user.updated',
        targetType: 'user',
        targetId: id,
        details: {
          email: before.email,
          ...(changes.active !== undefined && { active: changes.active }),
          ...(changes.roleIds !== undefined && {
            roleIds: { from: [...current.keys()], to: changes.roleIds },
            ...(changes.roleExpiresAt && {
              roleExpiresAt: changes.roleExpiresAt,
            }),
          }),
        },
        ip,
      });
    });
    this.access.invalidate();
    if (deactivated) {
      this.events.emit(ACCESS_EVENTS.memberDeactivationCommitted, {
        userId: id,
        tenantId,
        actor,
      } satisfies MemberDeactivatedEvent);
    }
  }

  /** The current tenant's memberships: users are global, so the tenant is named here. */
  private ofTenant(): SQL {
    return eq(memberships.tenantId, this.tenancy.tenantId());
  }

  /** Members with their role grants still running, their current units, whether SCIM manages them and their picture. */
  private async withGrants<T extends { id: string }>(items: T[]) {
    const ids = items.map((user) => user.id);
    const [assignments, units, scim, avatars] = ids.length
      ? await Promise.all([
          // An ended grant is gone: never reported, so never echoed back.
          this.db
            .select()
            .from(userRoles)
            .where(and(inArray(userRoles.userId, ids), liveGrant(userRoles))),
          this.units?.unitIdsOf(ids) ?? new Map<string, string[]>(),
          this.scim?.managedUserIds(ids) ?? new Set<string>(),
          this.avatars?.avatarUrls(ids) ?? new Map<string, string>(),
        ])
      : [
          [],
          new Map<string, string[]>(),
          new Set<string>(),
          new Map<string, string>(),
        ];
    return items.map((user) => {
      const own = assignments.filter((grant) => grant.userId === user.id);
      return {
        ...user,
        kind: 'user' as const,
        roleIds: own.map((grant) => grant.roleId),
        roles: own.map(({ roleId, expiresAt }) => ({ roleId, expiresAt })),
        unitIds: units.get(user.id) ?? [],
        managedByScim: scim.has(user.id),
        avatarUrl: avatars.get(user.id) ?? null,
      };
    });
  }

  /** Of these accounts, the ones that are active members of the current tenant. */
  async active(ids: readonly string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(
        and(
          inArray(users.id, [...ids]),
          eq(users.active, true),
          eq(memberships.tenantId, this.tenancy.tenantId()),
          eq(memberships.active, true),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * The active members holding a role (its key, or its id: roles made in
   * the API have no key) in a grant still running; with `among`, only
   * those of them.
   */
  async withRole(role: string, among?: readonly string[]): Promise<string[]> {
    if (among && !among.length) return [];
    const rows = await this.db
      .selectDistinct({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          z.uuid().safeParse(role).success
            ? or(eq(roles.key, role), eq(roles.id, role))
            : eq(roles.key, role),
          liveGrant(userRoles),
          among ? inArray(userRoles.userId, [...among]) : undefined,
        ),
      );
    return this.active(rows.map((row) => row.id));
  }

  /**
   * The active members who may `action` this record of `subject`, by their
   * permissions with their conditions. Those holding the permission at all
   * (or everything, as administrators do) are bounded by `limit`, so a
   * broad permission can't make the check slow.
   */
  async permitted(
    action: string,
    subject: string,
    record: Record<string, unknown>,
    limit = 2000,
  ): Promise<string[]> {
    const holders = await this.db
      .selectDistinct({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .where(
        and(
          or(
            and(
              eq(rolePermissions.subject, subject),
              eq(rolePermissions.action, action),
            ),
            and(
              eq(rolePermissions.subject, 'all'),
              eq(rolePermissions.action, 'manage'),
            ),
          ),
          liveGrant(userRoles),
        ),
      )
      .orderBy(userRoles.userId)
      .limit(limit);
    const allowed: string[] = [];
    for (const id of await this.active(holders.map((row) => row.id))) {
      // The ability reads only the principal's kind and id.
      const principal = { kind: 'user', id } as UserPrincipal;
      if (await this.access.can(principal, action, subject, record)) {
        allowed.push(id);
      }
    }
    return allowed;
  }

  /** A member's grants still running: role id → end (null: never). */
  private async liveGrantsOf(userId: string) {
    const rows = await this.db
      .select({ roleId: userRoles.roleId, expiresAt: userRoles.expiresAt })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), liveGrant(userRoles)));
    return new Map(rows.map((row) => [row.roleId, row.expiresAt]));
  }

  /** A member's role grants, each with its end; a kept end that passed meanwhile isn't written. */
  private async writeRoles(
    userId: string,
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
      await this.db
        .insert(userRoles)
        .values(
          unique.map((roleId) => ({ userId, roleId, expiresAt: end(roleId) })),
        );
    }
  }
}

/**
 * What replacing a member's roles with `roleIds` does to their live
 * grants: each role's end (`roleExpiresAt` when sent, else each kept grant
 * keeps its own), and the roles whose grant changes, which the actor must
 * be able to grant: given (an ended grant sent back included), taken away,
 * or kept with an end that moves.
 */
export function regrant(
  current: Map<string, Date | null>,
  roleIds: string[],
  roleExpiresAt?: Record<string, string>,
) {
  checkExpiries(roleIds, roleExpiresAt);
  const expiries: Record<string, string> =
    roleExpiresAt ??
    Object.fromEntries(
      roleIds.flatMap((roleId) => {
        const end = current.get(roleId);
        return end ? [[roleId, end.toISOString()]] : [];
      }),
    );
  const endOf = (roleId: string) =>
    expiries[roleId] ? Date.parse(expiries[roleId]) : null;
  const changed = [
    ...[...new Set(roleIds)].filter(
      (roleId) =>
        !current.has(roleId) ||
        (current.get(roleId)?.getTime() ?? null) !== endOf(roleId),
    ),
    ...[...current.keys()].filter((roleId) => !roleIds.includes(roleId)),
  ];
  return { changed, expiries };
}

/** Each grant's end names one of the roles, and is still to come (400). */
function checkExpiries(
  roleIds: string[],
  expiresAt: Record<string, string> = {},
) {
  const now = Date.now();
  for (const [roleId, when] of Object.entries(expiresAt)) {
    if (!roleIds.includes(roleId)) {
      throw new BadRequestException(
        `roleExpiresAt names ${roleId}, which isn't in roleIds.`,
      );
    }
    if (Date.parse(when) <= now) {
      throw new BadRequestException(
        `The grant of ${roleId} would already have ended.`,
      );
    }
  }
}
