import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/**
 * The runner that creates the due records, as `system:record-schedules`: it
 * writes only its audit entries (each record is created as the schedule's
 * owner, with the owner's permissions).
 */
export const RECORD_SCHEDULE_JOB = defineSystemJob({
  key: 'record-schedules',
  permissions: [],
});

export const RECURRENCE_PERMISSIONS = definePermissions({
  systemJobs: [RECORD_SCHEDULE_JOB],
});
