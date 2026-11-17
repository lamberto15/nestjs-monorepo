import { definePermissions } from '../access/permissions.js';

/** What impersonation adds to the catalog: acting as a member, for support. */
export const IMPERSONATION_PERMISSIONS = definePermissions({
  subjects: { Access: { actions: { impersonate: [] } } },
});
