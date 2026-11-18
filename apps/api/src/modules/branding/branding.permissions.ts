import { definePermissions } from '../../iam/access/permissions.js';

/** Who changes the tenant's branding: its colours, sender name and logos. Everyone signed in reads it. */
export const BRANDING_PERMISSIONS = definePermissions({
  subjects: {
    Branding: { actions: { update: [] } },
  },
});
