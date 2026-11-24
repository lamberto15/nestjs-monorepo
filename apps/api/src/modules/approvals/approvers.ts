import { Injectable } from '@nestjs/common';
import { MembersService } from '../../iam/access/members.service.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { ApprovalDelegationsRepository } from './approval-delegations.repository.js';
import type { ApproverRule } from './approval-policy.js';
import { ApprovalsRepository } from './approvals.repository.js';

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
    private readonly delegations: ApprovalDelegationsRepository,
    private readonly requests: ApprovalsRepository,
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
    const rows = await this.delegations.delegatesOf(userIds, subject);
    for (const { from, to } of rows) {
      map.set(from, [...(map.get(from) ?? []), to]);
    }
    return map;
  }

  /** Whom `userId` stands in for now, of every subject or of `subject`. */
  async delegators(userId: string, subject?: string) {
    return this.delegations.delegators(userId, subject);
  }

  /** The requester's display name: the user's or the API client's, as it is now. */
  async requesterName(requester: Requester) {
    const name = await this.requests.requesterName(
      requester.kind,
      requester.id,
    );
    return name ?? `${requester.kind}:${requester.id}`;
  }
}
