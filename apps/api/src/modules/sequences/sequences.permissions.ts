import { definePermissions } from '../../iam/access/permissions.js';

/** Who may create, change and delete naming series and set their counters (sequences.policy.ts). */
export const SEQUENCE_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageNamingSeries: [] } },
  },
});
