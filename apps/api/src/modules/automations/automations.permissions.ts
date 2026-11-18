import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/**
 * The runner, `system:automations`: it keeps the run log and disables a
 * rule; it never does a rule's actions (they run as the rule's owner).
 */
export const AUTOMATIONS_JOB = defineSystemJob({
  key: 'automations',
  permissions: [],
});

/**
 * Who sees rules and their runs (`read`), and who creates, simulates,
 * activates, disables and deletes them (`configure`: they run with the
 * permissions of whoever activates them). No seed role has either.
 */
export const AUTOMATION_PERMISSIONS = definePermissions({
  subjects: {
    AutomationRule: { actions: { read: [], configure: [] } },
  },
  systemJobs: [AUTOMATIONS_JOB],
});
