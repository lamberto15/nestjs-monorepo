import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Who may share a record template with the whole tenant, and change or
 * delete shared ones (templates.service.ts). Anyone signed in keeps their own.
 */
export const TEMPLATE_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageTemplates: [] } },
  },
});
