import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { and, eq, inArray, isNotNull, or, type SQL, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countMatching,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { authConfig } from '../auth/auth.config.js';
import { apiClients, memberships, users } from '../auth/auth.tables.js';
import {
  PRINCIPAL_LIST,
  PRINCIPALS_ID,
  type userList,
} from './access.lists.js';
import {
  liveGrant,
  rolePermissions,
  roles,
  userRoles,
} from './access.tables.js';

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
 * The queries of the tenant's members (users are global: a member is one
 * through a membership in the tenant, named here), their role grants, and
 * the principals' picker, in the request's tenant and the ambient
 * transaction.
 */
@Injectable()
export class MembersRepository {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
  ) {}

  /** The current tenant's memberships: users are global, so the tenant is named here. */
  private ofTenant(): SQL {
    return eq(memberships.tenantId, this.tenancy.tenantId());
  }

  /** A page of the tenant's members, by `list` (its unit filter as the directory reads it). */
  async page(query: ListQuery, list: ReturnType<typeof userList>) {
    const where = and(this.ofTenant(), list.where(query));
    const [rows, total] = await Promise.all([
      this.db
        .select({ ...memberColumns, ...list.sortSelect(query) })
        .from(users)
        .innerJoin(memberships, eq(memberships.userId, users.id))
        .where(and(this.ofTenant(), list.where(query, users.id)))
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
    return toPage(rows, query, total);
  }

  async findMember(id: string) {
    const [member] = await this.db
      .select(memberColumns)
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(and(this.ofTenant(), eq(users.id, id)));
    return member;
  }

  /** The member's membership, locked until the transaction ends. */
  async lockMembership(userId: string) {
    const [membership] = await this.db
      .select({ active: memberships.active })
      .from(memberships)
      .where(and(this.ofTenant(), eq(memberships.userId, userId)))
      .for('update');
    return membership;
  }

  async setActive(userId: string, active: boolean) {
    await this.db
      .update(memberships)
      .set({ active })
      .where(and(this.ofTenant(), eq(memberships.userId, userId)));
  }

  /** Every grant of the user, ended ones too. */
  async deleteGrants(userId: string) {
    await this.db.delete(userRoles).where(eq(userRoles.userId, userId));
  }

  async insertGrants(
    userId: string,
    grants: { roleId: string; expiresAt: Date | null }[],
  ) {
    await this.db
      .insert(userRoles)
      .values(grants.map((grant) => ({ userId, ...grant })));
  }

  /** The grants of these users still running. */
  liveGrantsOf(userIds: string[]) {
    return this.db
      .select()
      .from(userRoles)
      .where(and(inArray(userRoles.userId, userIds), liveGrant(userRoles)));
  }

  /** Of these accounts, the ones that are active members of the current tenant. */
  async activeAmong(ids: string[]) {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .where(
        and(
          inArray(users.id, ids),
          eq(users.active, true),
          this.ofTenant(),
          eq(memberships.active, true),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** Who holds a role of this key (or, `byId`, this key or id) by a grant still running; `among` narrows. */
  async holdersOf(role: string, byId: boolean, among?: string[]) {
    const rows = await this.db
      .selectDistinct({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          byId
            ? or(eq(roles.key, role), eq(roles.id, role))
            : eq(roles.key, role),
          liveGrant(userRoles),
          among ? inArray(userRoles.userId, among) : undefined,
        ),
      );
    return rows.map((row) => row.id);
  }

  /** Who holds `subject.action` (or everything), by a grant still running, the first `limit` of them. */
  async holdersOfPermission(action: string, subject: string, limit: number) {
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
    return holders.map((row) => row.id);
  }

  /** The members and (with API_CLIENTS on) the API clients of the tenant, one page of both. */
  async principalsPage(query: ListQuery) {
    const members = this.db
      .select({
        id: users.id,
        kind: sql<'user' | 'client'>`'user'`.as('kind'),
        // Named as the list's fields read them (a column keeps its own name).
        label: sql<string>`${users.name}`.as('label'),
        email: sql<string | null>`${users.email}`.as('email'),
        active: sql<boolean>`(${users.active} and ${memberships.active})`.as(
          'active',
        ),
      })
      .from(users)
      .innerJoin(
        memberships,
        and(eq(memberships.userId, users.id), this.ofTenant()),
      );
    // API_CLIENTS=off: no client shows here either.
    const principals = (
      this.auth.apiClients
        ? members.unionAll(
            this.db
              .select({
                id: apiClients.id,
                kind: sql<'user' | 'client'>`'client'`.as('kind'),
                label: sql<string>`${apiClients.name}`.as('label'),
                email: sql<string | null>`null::text`.as('email'),
                active: sql<boolean>`${apiClients.active}`.as('active'),
              })
              .from(apiClients),
          )
        : members
    ).as('principals');
    const where = PRINCIPAL_LIST.where(query);
    const [rows, total] = await Promise.all([
      this.db
        .select({
          id: principals.id,
          kind: principals.kind,
          label: principals.label,
          email: principals.email,
          active: principals.active,
          ...PRINCIPAL_LIST.sortSelect(query),
        })
        .from(principals)
        .where(and(where, afterCursor(PRINCIPALS_ID, query)))
        .orderBy(...pageOrder(PRINCIPALS_ID, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(principals)
          .where(where),
        query,
      ),
    ]);
    return toPage(rows, query, total);
  }
}
