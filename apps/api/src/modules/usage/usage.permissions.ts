import { definePermissions } from '../../iam/access/permissions.js';

/**
 * What the usage module adds to the catalog: reading any API client's
 * usage, and setting its daily quota.
 */
export const USAGE_PERMISSIONS = definePermissions({
  subjects: {
    Usage: { actions: { read: [], setClientQuota: [] } },
  },
});
