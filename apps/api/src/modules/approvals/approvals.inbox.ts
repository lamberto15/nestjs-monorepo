import { Injectable } from '@nestjs/common';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import {
  type InboxEntry,
  type InboxSource,
  InboxSourceOf,
} from '../inbox/inbox.source.js';
import { ApprovalsRepository } from './approvals.repository.js';

/**
 * The inbox's approvals: requests waiting on the user's decision now (their
 * own assignment, or of someone they stand in for), and their own requests
 * sent back for changes. Read from the requests, so an item is gone the
 * moment it is decided, cancelled or resubmitted. Done by deciding or
 * resubmitting, never dismissed.
 */
@InboxSourceOf('approval')
@Injectable()
export class ApprovalInboxSource implements InboxSource {
  constructor(private readonly repository: ApprovalsRepository) {}

  async items(
    principal: Principal,
    page: { limit: number; after?: string },
  ): Promise<InboxEntry[]> {
    if (principal.kind !== 'user') return [];
    const rows = await this.repository.inbox(
      principal.id,
      principalKey(principal),
      page,
    );
    return rows.map((row) => ({
      id: row.id,
      at: row.createdAt,
      kind: row.status === 'pending' ? 'approval.decide' : 'approval.revise',
      data: {
        action: row.action,
        title: row.title,
        requester: row.requesterName,
      },
      link: `/approvals/${row.id}`,
      dueAt: row.status === 'pending' ? row.dueAt : null,
      subject: row.subject,
      recordId: row.recordId,
      dedupe: `approval:${row.id}`,
    }));
  }
}
