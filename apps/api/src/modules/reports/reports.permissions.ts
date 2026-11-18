import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/**
 * The runner that starts the due reports, as `system:report-runner`: it
 * writes only its own audit entries and the reports' run state (each
 * export runs, and is audited, as the report's owner).
 */
export const REPORT_RUNNER_JOB = defineSystemJob({
  key: 'report-runner',
  permissions: [],
});

export const REPORTS_PERMISSIONS = definePermissions({
  systemJobs: [REPORT_RUNNER_JOB],
});
