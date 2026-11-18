import {
  definePermissions,
  defineSystemJob,
} from '../iam/access/permissions.js';

/**
 * The actor of everything the demo seed writes (`system:demo-seed`): it may
 * manage units, as the administrator whose requests it stands in for.
 */
export const DEMO_SEED_JOB = defineSystemJob({
  key: 'demo-seed',
  permissions: [
    { subject: 'Access', action: 'manageOrganizationalUnits', conditions: [] },
  ],
});

/** Its declaration, registered by DemoModule. */
export const DEMO_PERMISSIONS = definePermissions({
  subjects: {},
  systemJobs: [DEMO_SEED_JOB],
});
