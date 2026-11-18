import { definePermissions } from '../access/permissions.js';

/** What the auth-policy module adds to the catalog: reading and changing the tenant's sign-in policy. */
export const AUTH_POLICY_PERMISSIONS = definePermissions({
  subjects: {
    Access: {
      actions: {
        readAuthPolicy: [],
        updateAuthPolicy: [],
        managePlatformAuthPolicy: [],
      },
    },
  },
});
