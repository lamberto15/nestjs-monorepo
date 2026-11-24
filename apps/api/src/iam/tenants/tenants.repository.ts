import { InjectTransaction } from '@nestjs-cls/transactional';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  lt,
  lte,
  not,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  countMatching,
  pageOffset,
  pageOrder,
  toPage,
} from '../../core/http/pagination.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { roles, userRoles } from '../access/access.tables.js';
import { authConfig } from '../auth/auth.config.js';
import {
  memberships,
  refreshTokens,
  sessions,
  users,
} from '../auth/auth.tables.js';
import { tokenSessionId } from '../auth/token-session.js';
import { tenantList } from './tenants.lists.js';
import { tenantLifecycle } from './tenants.tables.js';

/** A tenant's own columns, as the jobs read them. */
const tenantColumns = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  active: tenants.active,
  frozenAt: tenants.frozenAt,
  createdAt: tenants.createdAt,
  updatedAt: tenants.updatedAt,
};

/**
 * The queries of the tenants (a global table: nothing for row-level
 * security to narrow), their lifecycle, and what making, joining and
 * ending one writes, in the ambient transaction and scope.
 */
@Injectable()
export class TenantsRepository {
  private readonly list: ReturnType<typeof tenantList>;
  private readonly operator: SQL;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly tenancy: Tenancy,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(tenancyConfig.KEY)
    private readonly tenancyMode: ConfigType<typeof tenancyConfig>,
  ) {
    this.operator = this.operatorCondition();
    this.list = tenantList(this.operator);
  }

  /**
   * Which tenant is the operators' (as OperatorGuard decides): with
   * TENANCY=single the oldest (the one), else the one OPERATOR_TENANT names,
   * else none.
   */
  private operatorCondition(): SQL {
    if (this.tenancyMode.mode === 'single') {
      const oldest = this.db
        .select({ id: tenants.id })
        .from(tenants)
        .orderBy(asc(tenants.createdAt), asc(tenants.id))
        .limit(1);
      return inArray(tenants.id, oldest);
    }
    return this.auth.operatorTenant
      ? eq(tenants.slug, this.auth.operatorTenant)
      : sql`false`;
  }

  private columns() {
    return {
      id: tenants.id,
      slug: tenants.slug,
      name: tenants.name,
      active: tenants.active,
      operator: sql<boolean>`(${this.operator})`,
      createdBySignUp: sql<boolean>`coalesce(${tenantLifecycle.createdBySignUp}, false)`,
      deletionRequestedAt: tenantLifecycle.deletionRequestedAt,
      deletionScheduledFor: tenantLifecycle.deletionScheduledFor,
      deletionStartedAt: tenantLifecycle.deletionStartedAt,
      createdAt: tenants.createdAt,
      updatedAt: tenants.updatedAt,
    };
  }

  /** A page of the tenants, newest first unless sorted. */
  async page(query: ListQuery) {
    const joined = () =>
      this.db
        .select({ ...this.columns(), ...this.list.sortSelect(query) })
        .from(tenants)
        .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id));
    const [rows, total] = await Promise.all([
      joined()
        .where(this.list.where(query, tenants.id))
        .orderBy(...pageOrder(tenants.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countMatching(
        this.db,
        this.db
          .select({ one: sql`1` })
          .from(tenants)
          .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
          .where(this.list.where(query)),
        query,
      ),
    ]);
    return toPage(rows, query, total);
  }

  /** One tenant as the operators' routes show it. */
  async findView(id: string) {
    const [tenant] = await this.db
      .select(this.columns())
      .from(tenants)
      .leftJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
      .where(eq(tenants.id, id));
    return tenant;
  }

  /** Locks the tenant's row until the transaction ends; false when there is none. */
  async lock(id: string) {
    const [row] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.id, id))
      .for('update');
    return !!row;
  }

  /** Locks the tenant's row; whether it is the operators', undefined when there is none. */
  async lockForPurge(id: string) {
    const [locked] = await this.db
      .select({ id: tenants.id, operator: this.columns().operator })
      .from(tenants)
      .where(eq(tenants.id, id))
      .for('update');
    return locked;
  }

  async update(
    id: string,
    values: { name?: string; slug?: string; active?: boolean },
  ) {
    await this.db.update(tenants).set(values).where(eq(tenants.id, id));
  }

  async delete(id: string) {
    const [row] = await this.db
      .delete(tenants)
      .where(eq(tenants.id, id))
      .returning();
    return row;
  }

  async scheduleDeletion(
    tenantId: string,
    requestedAt: Date,
    scheduledFor: Date,
  ) {
    await this.db
      .insert(tenantLifecycle)
      .values({
        tenantId,
        deletionRequestedAt: requestedAt,
        deletionScheduledFor: scheduledFor,
      })
      .onConflictDoUpdate({
        target: tenantLifecycle.tenantId,
        set: {
          deletionRequestedAt: requestedAt,
          deletionScheduledFor: scheduledFor,
        },
      });
  }

  async unscheduleDeletion(tenantId: string) {
    await this.db
      .update(tenantLifecycle)
      .set({ deletionRequestedAt: null, deletionScheduledFor: null })
      .where(eq(tenantLifecycle.tenantId, tenantId));
  }

  async markCreatedBySignUp(tenantId: string) {
    await this.db
      .insert(tenantLifecycle)
      .values({ tenantId, createdBySignUp: true });
  }

  /** The id of the current tenant's role of this key. */
  async roleIdByKey(key: string) {
    const [role] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.key, key));
    return role?.id;
  }

  /** The current tenant's roles of these keys. */
  async roleIdsByKeys(keys: string[]) {
    const rows = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.key, keys));
    return rows.map((row) => row.id);
  }

  /** Makes the user a member of the current tenant, unless one already. */
  async insertMembership(userId: string, { ifAbsent = false } = {}) {
    const insert = this.db
      .insert(memberships)
      .values({ tenantId: this.tenancy.tenantId(), userId });
    await (ifAbsent ? insert.onConflictDoNothing() : insert);
  }

  async insertGrants(userId: string, roleIds: string[]) {
    await this.db
      .insert(userRoles)
      .values(roleIds.map((roleId) => ({ userId, roleId })));
  }

  async insertUser(values: typeof users.$inferInsert) {
    const [row] = await this.db.insert(users).values(values).returning();
    return row!;
  }

  /** Stamps the membership as the user's latest choice. */
  async selectMembership(userId: string, tenantId: string) {
    await this.db
      .update(memberships)
      .set({ selectedAt: new Date() })
      .where(
        and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)),
      );
  }

  /** Deletes the sessions acting in the tenant; returns their ids. */
  deleteSessionsIn(tenantId: string) {
    return this.db
      .delete(sessions)
      .where(sql`${sessions.metadata} ->> 'tenantId' = ${tenantId}`)
      .returning({ id: sessions.id });
  }

  /** Revokes the live refresh tokens acting in the tenant; returns their token sessions. */
  revokeRefreshTokensIn(tenantId: string) {
    return this.db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(
        and(
          eq(refreshTokens.revoked, false),
          sql`${refreshTokens.claims} ->> 'tid' = ${tenantId}`,
        ),
      )
      .returning({ sid: tokenSessionId });
  }

  /** The sign-ups' tenants made before `cutoff` with no verified member, `limit` of them. */
  unverifiedSignUps(cutoff: Date, limit: number) {
    const verifiedMember = this.db
      .select({ one: sql`1` })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.tenantId, tenants.id),
          eq(users.emailVerified, true),
        ),
      );
    return this.db
      .select(tenantColumns)
      .from(tenants)
      .innerJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
      .where(
        and(
          eq(tenantLifecycle.createdBySignUp, true),
          lt(tenants.createdAt, cutoff),
          not(exists(verifiedMember)),
        ),
      )
      .orderBy(tenants.createdAt)
      .limit(limit);
  }

  /** Whether a member of the tenant is verified, their accounts locked until the transaction ends. */
  async anyMemberVerified(tenantId: string) {
    const members = await this.db
      .select({ verified: users.emailVerified })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.tenantId, tenantId))
      .for('update', { of: users });
    return members.some(({ verified }) => verified);
  }

  /** The tenants whose erase is due at `now`, oldest schedule first, `limit` of them. */
  dueForDeletion(now: Date, limit: number) {
    return this.db
      .select(tenantColumns)
      .from(tenants)
      .innerJoin(tenantLifecycle, eq(tenantLifecycle.tenantId, tenants.id))
      .where(
        and(
          isNotNull(tenantLifecycle.deletionScheduledFor),
          lte(tenantLifecycle.deletionScheduledFor, now),
        ),
      )
      .orderBy(asc(tenantLifecycle.deletionScheduledFor))
      .limit(limit);
  }

  /** Marks the erase started (once) if still due at `now`: true when it is. */
  async claimDeletion(tenantId: string, now: Date) {
    const claimed = await this.db
      .update(tenantLifecycle)
      .set({
        deletionStartedAt: sql`coalesce(${tenantLifecycle.deletionStartedAt}, now())`,
      })
      .where(
        and(
          eq(tenantLifecycle.tenantId, tenantId),
          isNotNull(tenantLifecycle.deletionScheduledFor),
          lte(tenantLifecycle.deletionScheduledFor, now),
        ),
      )
      .returning({ tenantId: tenantLifecycle.tenantId });
    return claimed.length > 0;
  }
}
