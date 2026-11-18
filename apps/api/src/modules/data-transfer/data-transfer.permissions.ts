import { definePermissions } from '../../iam/access/permissions.js';

/**
 * What the data transfers add to the catalog: exporting a whole tenant,
 * held by the operators' administrators (the route is `@OperatorOnly()` too).
 */
export const DATA_TRANSFER_PERMISSIONS = definePermissions({
  subjects: { Access: { actions: { exportTenants: [] } } },
});
