import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { systemPrincipal } from '../../iam/auth/principal.js';
import { DELETED_USER_NAME } from '../../iam/personal-data/account-deletion.job.js';
import {
  PersonalData,
  type PersonalDataSection,
  type PersonalDataSubject,
} from '../../iam/personal-data/personal-data.js';
import { ApprovalEngine } from './approval-engine.service.js';
import {
  approvalAssignments,
  approvalDelegations,
  approvalEvents,
  approvalRequests,
} from './approvals.tables.js';

const DELETION = systemPrincipal({
  key: 'account-deletion',
  label: 'Account deletion',
});

/**
 * The requests the person made, their decisions and their delegations: in
 * their export. At the deletion requests and decisions stay (other people's
 * records depend on them), the names copied onto them go; their pending
 * assignments close and their stages are settled again; their delegations
 * end.
 */
@PersonalData({ name: 'approvals', scopes: ['tenant'] })
@Injectable()
export class ApprovalsPersonalData implements PersonalDataSection {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly engine: ApprovalEngine,
  ) {}

  async *rows({ key, userId }: PersonalDataSubject) {
    yield (
      await this.db
        .select({
          id: approvalRequests.id,
          subject: approvalRequests.subject,
          recordId: approvalRequests.recordId,
          action: approvalRequests.action,
          status: approvalRequests.status,
          title: approvalRequests.title,
          comment: approvalRequests.comment,
          createdAt: approvalRequests.createdAt,
        })
        .from(approvalRequests)
        .where(eq(approvalRequests.requester, key))
        .orderBy(asc(approvalRequests.id))
    ).map((row) => ({ kind: 'request', ...row }));
    yield (
      await this.db
        .select({
          id: approvalAssignments.id,
          requestId: approvalAssignments.requestId,
          decision: approvalAssignments.status,
          comment: approvalAssignments.comment,
          onBehalfOf: approvalAssignments.onBehalfOf,
          decidedAt: approvalAssignments.decidedAt,
        })
        .from(approvalAssignments)
        .where(eq(approvalAssignments.decidedBy, userId))
        .orderBy(asc(approvalAssignments.id))
    ).map((row) => ({ kind: 'decision', ...row }));
    yield (
      await this.db
        .select()
        .from(approvalDelegations)
        .where(eq(approvalDelegations.fromUserId, userId))
        .orderBy(asc(approvalDelegations.id))
    ).map((row) => ({ kind: 'delegation', ...row }));
  }

  async erase({ key, userId }: PersonalDataSubject) {
    // Closes their pending assignments and ends their delegations.
    await this.engine.release(userId, DELETION);
    await this.db
      .update(approvalRequests)
      .set({ requesterName: DELETED_USER_NAME })
      .where(eq(approvalRequests.requester, key));
    await this.db
      .update(approvalAssignments)
      .set({ decidedByName: DELETED_USER_NAME })
      .where(eq(approvalAssignments.decidedBy, userId));
    await this.db
      .update(approvalEvents)
      .set({ actorName: DELETED_USER_NAME })
      .where(eq(approvalEvents.actor, key));
  }
}
