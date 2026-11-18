import { definePermissions, defineSystemJob } from '../access/permissions.js';

/** The nightly erasure of accounts whose deletion's grace period ended. */
export const ACCOUNT_DELETION_JOB = defineSystemJob({
  key: 'account-deletion',
  permissions: [],
});

/** What the personal-data module adds to the catalog: its job. */
export const PERSONAL_DATA_PERMISSIONS = definePermissions({
  systemJobs: [ACCOUNT_DELETION_JOB],
});
