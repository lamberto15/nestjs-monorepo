import { z } from 'zod';
import { defineSettings, setting } from '../settings/settings.types.js';

/** How long a delegation (out of office) may last: a stand-in for a holiday, not for good. */
export const APPROVAL_MAX_DELEGATION_DAYS = setting({
  key: 'approvals.maxDelegationDays',
  label: 'Longest delegation (days)',
  description:
    'How long a delegation of approvals may last, from its start to its end, in days.',
  schema: z.number().int().min(1).max(3650),
  default: 90,
  scopes: ['tenant'],
});

export const APPROVAL_SETTINGS = defineSettings([APPROVAL_MAX_DELEGATION_DAYS]);
