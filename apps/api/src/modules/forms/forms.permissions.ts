import { definePermissions } from '../../iam/access/permissions.js';

/**
 * Runtime forms' subject: four separate rights, none implying another.
 * `edit`, not `manage`: CASL reads `manage` as every action, submissions'
 * answers included. Administrators hold all four.
 */
export const FORM_PERMISSIONS = definePermissions({
  subjects: {
    Form: {
      actions: { read: [], submit: [], edit: [], readResponses: [] },
    },
  },
});
