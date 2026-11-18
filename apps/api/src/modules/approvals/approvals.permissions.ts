import { z } from 'zod';
import {
  type Condition,
  definePermissions,
} from '../../iam/access/permissions.js';
import { APPROVALS_JOB } from './approvals.events.js';
import { approvalRequests } from './approvals.tables.js';

/** "Only approvals of one subject": an auditor of invoices reads invoice approvals. */
const ofSubject: Condition<{ subject: string }> = {
  params: z.object({ subject: z.string().min(1).max(100) }),
  input: { name: 'subject', type: 'text' },
  where: (_principal, params) => [[approvalRequests.subject, params.subject]],
};

/**
 * Taking part needs no permission: anyone reads the requests they made or
 * decide, and deciding takes being assigned (or standing in), never a role
 * alone. These are for those who oversee approvals.
 */
export const APPROVAL_PERMISSIONS = definePermissions({
  subjects: {
    Approval: {
      conditions: { ofSubject },
      actions: {
        read: ['ofSubject'],
        cancel: ['ofSubject'],
        abandon: ['ofSubject'],
        managePolicies: [],
      },
    },
  },
  systemJobs: [APPROVALS_JOB],
});
