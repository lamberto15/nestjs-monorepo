import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  type AnyColumn,
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { requireTenantId } from '../../core/tenancy/tenant-scope.js';
import { MembersService } from '../../iam/access/members.service.js';
import { apiClients, memberships, users } from '../../iam/auth/auth.tables.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import type { ApproverRule } from './approval-policy.js';
import { approvalDelegations } from './approvals.tables.js';

/** Who asked: `user:<id>` or `client:<id>`. */
export interface Requester {
  kind: 'user' | 'client';
  id: string;
}

export const requesterOf = (key: string): Requester => {
  const [kind, id] = key.split(':') as [string, string];
  if (kind !== 'user' && kind !== 'client') {
    // A request is asked for by a user or a client: never `system:…`.
    throw new Error(`An approval requester is a user or a client, not ${key}.`);
  }
  return { kind, id };
};

/** What the rules are told about the request: the record is loaded once, when asked for. */
export interface RuleContext {
  subject: string;
  requester: Requester;
  record(): Promise<Record<string, unknown> | null>;
}

/** Subqueries with no connection: they run inside the caller's query. */
const subquery = new QueryBuilder();

/**
 * The user (a column holding their id) is an active member of the current
 * tenant: who may decide, or stand in, here. Memberships are a global
 * table, so the tenant is named.
 */
export const activeMember = (userId: AnyColumn) =>
  exists(
    subquery
      .select({ one: sql`1` })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.tenantId, requireTenantId('An approver')),
          eq(memberships.active, true),
        ),
      ),
  );

/**
 * Who a policy's rules name, as they are when a stage starts: role
 * holders and permitted members come from iam/access (MembersService), a
 * unit's levels and members from iam/organization (OrganizationService).
 */
@Injectable()
export class Approvers {
  /** Candidates of the `permission` rule checked one by one: a bound, so a broad permission can't make a stage start slow. */
  private static readonly MAX_CANDIDATES = 2000;

  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly members: MembersService,
    private readonly organization: OrganizationService,
  ) {}

  /**
   * The users the rules name who may decide: active members of the
   * request's tenant, never the requester (no self-approval), in the order
   * the rules named them.
   */
  async resolve(context: RuleContext, rules: readonly ApproverRule[]) {
    const named = new Set<string>();
    for (const rule of rules) {
      for (const id of await this.named(context, rule)) named.add(id);
    }
    const requester =
      context.requester.kind === 'user' ? context.requester.id : null;
    const candidates = [...named].filter((id) => id !== requester);
    if (!candidates.length) return [];
    const active = new Set(await this.members.active(candidates));
    return candidates.filter((id) => active.has(id));
  }

  private async named(context: RuleContext, rule: ApproverRule) {
    switch (rule.type) {
      case 'users':
        return rule.userIds;
      case 'role':
        return this.members.withRole(rule.role);
      case 'unitRole':
        return this.unitRole(context, rule);
      case 'permission':
        return this.permitted(context, rule);
    }
  }

  /**
   * Users holding the role among the current members of the requester's
   * units: `levelsUp` steps above them, and with `nearest` further up
   * until someone other than the requester is found ("the lead of my unit",
   * and a lead's own request goes to the lead above).
   */
  private async unitRole(
    context: RuleContext,
    rule: Extract<ApproverRule, { type: 'unitRole' }>,
  ) {
    if (context.requester.kind !== 'user') return []; // an API client belongs to no unit
    const me = context.requester.id;
    const levels = await this.organization.ancestry(
      await this.organization.unitsOf(me),
    );
    const top = rule.nearest ? levels.length - 1 : rule.levelsUp;
    for (let level = rule.levelsUp; level <= top; level++) {
      const members = (
        await this.organization.currentMembers(levels[level] ?? [])
      ).filter((id) => id !== me);
      const holders = await this.members.withRole(rule.role, members);
      if (holders.length) return holders;
    }
    return [];
  }

  /** Users who may do the action on the record, by their permissions (conditions included). */
  private async permitted(
    context: RuleContext,
    rule: Extract<ApproverRule, { type: 'permission' }>,
  ) {
    const subject = rule.subject ?? context.subject;
    const record = await context.record();
    if (!record) return [];
    return this.members.permitted(
      rule.action,
      subject,
      record,
      Approvers.MAX_CANDIDATES,
    );
  }

  /** Who stands in for these users now (out of office), for requests of `subject`. */
  async delegatesOf(userIds: readonly string[], subject: string) {
    const map = new Map<string, string[]>();
    if (!userIds.length) return map;
    const rows = await this.db
      .select({
        from: approvalDelegations.fromUserId,
        to: approvalDelegations.toUserId,
      })
      .from(approvalDelegations)
      .where(
        and(
          inArray(approvalDelegations.fromUserId, [...userIds]),
          lte(approvalDelegations.startsAt, sql`now()`),
          gt(approvalDelegations.endsAt, sql`now()`),
          or(
            isNull(approvalDelegations.subject),
            eq(approvalDelegations.subject, subject),
          ),
          activeMember(approvalDelegations.toUserId),
        ),
      );
    for (const { from, to } of rows) {
      map.set(from, [...(map.get(from) ?? []), to]);
    }
    return map;
  }

  /** Whom `userId` stands in for now, of every subject or of `subject`. */
  async delegators(userId: string, subject?: string) {
    const rows = await this.db
      .select({
        from: approvalDelegations.fromUserId,
        subject: approvalDelegations.subject,
      })
      .from(approvalDelegations)
      .where(
        and(
          eq(approvalDelegations.toUserId, userId),
          lte(approvalDelegations.startsAt, sql`now()`),
          gt(approvalDelegations.endsAt, sql`now()`),
          subject
            ? or(
                isNull(approvalDelegations.subject),
                eq(approvalDelegations.subject, subject),
              )
            : undefined,
        ),
      );
    return rows;
  }

  /** The requester's display name: the user's or the API client's, as it is now. */
  async requesterName(requester: Requester) {
    const [row] =
      requester.kind === 'user'
        ? await this.db
            .select({ name: users.name })
            .from(users)
            .where(eq(users.id, requester.id))
        : await this.db
            .select({ name: apiClients.name })
            .from(apiClients)
            .where(eq(apiClients.id, requester.id));
    return row?.name ?? `${requester.kind}:${requester.id}`;
  }
}
