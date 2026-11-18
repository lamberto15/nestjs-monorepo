import { definePermissions } from '../../iam/access/permissions.js';

/** Who may add, change, reorder and deactivate custom fields (custom-fields.policy.ts). */
export const CUSTOM_FIELD_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageCustomFields: [] } },
  },
});
