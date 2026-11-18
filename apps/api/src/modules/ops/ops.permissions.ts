import { definePermissions } from '../../iam/access/permissions.js';

/**
 * What the ops module adds to the catalog: five `Access` actions, held by
 * the operators' administrators (every route is `@OperatorOnly()` too).
 */
export const OPS_PERMISSIONS = definePermissions({
  subjects: {
    Access: {
      actions: {
        viewOps: [],
        pauseQueues: [],
        retryJobs: [],
        discardJobs: [],
        testIntegrations: [],
      },
    },
  },
});
