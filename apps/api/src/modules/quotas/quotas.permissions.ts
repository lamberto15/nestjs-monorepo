import { definePermissions } from '../../iam/access/permissions.js';

/**
 * What the quotas module adds to the catalog: reading the tenant's own use
 * against its limits, and the operators' plans and per tenant limits (their
 * routes are `@OperatorOnly()` on top).
 */
export const QUOTA_PERMISSIONS = definePermissions({
  subjects: {
    Quota: { actions: { read: [], setLimits: [] } },
  },
});
