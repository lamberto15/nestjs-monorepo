import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/** Sends the SMS and push messages queued, within the toll-fraud caps. */
export const MESSAGING_JOB = defineSystemJob({
  key: 'messaging',
  permissions: [],
});

/** STOP and START arriving from the SMS provider. */
export const MESSAGING_INBOUND_JOB = defineSystemJob({
  key: 'messaging-inbound',
  permissions: [],
});

/** The nightly sweep of stale devices and old cap counters. */
export const MESSAGING_RETENTION_JOB = defineSystemJob({
  key: 'messaging-retention',
  permissions: [],
});

/** Messaging has no permissions of its own: its routes are the caller's own. */
export const MESSAGING_PERMISSIONS = definePermissions({
  systemJobs: [MESSAGING_JOB, MESSAGING_INBOUND_JOB, MESSAGING_RETENTION_JOB],
});
