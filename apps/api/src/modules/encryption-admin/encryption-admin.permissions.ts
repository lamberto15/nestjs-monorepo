import { definePermissions } from '../../iam/access/permissions.js';

/** The `Access` action that guards the encryption routes (operators only on top). */
export const ENCRYPTION_ADMIN_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageEncryption: [] } },
  },
});
