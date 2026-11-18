import { definePermissions } from '../../iam/access/permissions.js';

/** Who may create, change and delete tags (tags.policy.ts). Reading them, and tagging a record, need no permission of their own. */
export const TAGS_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageTags: [] } },
  },
});
