import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Who may share a saved view with the whole tenant, and change or delete
 * shared ones (views.service.ts). Anyone signed in keeps their own.
 */
export const VIEW_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageViews: [] } },
  },
});
