import { defineEvent } from '../../core/outbox/events.js';
import type { SecurityAlertKind } from './account.mails.js';

/**
 * A security alert told to an account's owner (SecurityAlerts): published in
 * the transaction of the change (a sign-in's device record, a credential's
 * change), in no tenant, whatever the outcome of the mail. `tenantId` is
 * the tenant the person was acting in, null for none: modules/notifications
 * stores the in-app notice there.
 */
export interface SecurityAlerted {
  userId: string;
  kind: SecurityAlertKind;
  /** The alert's arguments: `ip`, a sign-in's `device`, a passkey's `name`. */
  args: Record<string, string>;
  tenantId: string | null;
  /** When it happened (ISO 8601). */
  at: string;
}

export const securityAlerted = defineEvent<SecurityAlerted>(
  'account.security-alerted',
);
