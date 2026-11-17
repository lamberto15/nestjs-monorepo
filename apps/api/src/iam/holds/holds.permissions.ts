import { definePermissions } from '../access/permissions.js';

/**
 * What the holds module adds to the catalog: the `Access` action that
 * guards placing, listing and releasing a legal hold.
 */
export const HOLD_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageLegalHolds: [] } },
  },
});
