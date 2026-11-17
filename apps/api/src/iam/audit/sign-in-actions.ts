/**
 * The actions of a tenant's sign-in log: its members' sign-ins, a second
 * entry in the tenant the sign-in lands in (the account-level
 * `auth.signed-in` stays in no tenant). The partial indexes of
 * `audit_log` name them as literals (audit.tables.ts).
 */
export const SIGN_IN_ACTIONS = {
  succeeded: 'member.signed-in',
  failed: 'member.sign-in-failed',
} as const;
