import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/** The retention batches, run as `system:retention`: it writes only its audit entries. */
export const RETENTION_JOB = defineSystemJob({
  key: 'retention',
  permissions: [],
});

/**
 * What the retention module adds to the catalog: the `Access` action that
 * guards the rules, and the job that purges.
 */
export const RETENTION_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageRetention: [] } },
  },
  systemJobs: [RETENTION_JOB],
});
