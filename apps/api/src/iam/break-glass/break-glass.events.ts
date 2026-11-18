import { defineEvent } from '../../core/outbox/events.js';

/**
 * A grant opened: published in the tenant it opens, in the transaction of
 * its audit entries, so a subscriber runs in that tenant (the notifications
 * module tells its administrators).
 */
export const breakGlassStarted = defineEvent<{
  grantId: string;
  operator: { id: string; email: string };
  reason: string;
  expiresAt: string;
  /** User ids: the tenant's administrators (its built-in role, live, active members). */
  administrators: string[];
  ip?: string;
}>('tenancy.break-glass-started');
