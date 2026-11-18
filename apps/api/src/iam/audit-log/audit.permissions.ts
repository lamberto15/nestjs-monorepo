import { definePermissions } from '../access/permissions.js';

/** What the audit routes add to the catalog: who reads the audit log and the sign-in log. */
export const AUDIT_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { readAudit: [] } },
  },
});
