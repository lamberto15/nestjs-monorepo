import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/** Applies the bounces and complaints a mail provider reports (the actor of the list's audit entries). */
export const MAIL_INTAKE_JOB = defineSystemJob({
  key: 'mail-intake',
  permissions: [],
});

/** The nightly deletion of old mail events. */
export const MAIL_EVENTS_RETENTION_JOB = defineSystemJob({
  key: 'mail-events-retention',
  permissions: [],
});

/**
 * The suppression list: the addresses mail is not sent to. The list holds
 * every tenant's addresses, so its routes are the operators' too
 * (`@OperatorOnly()` on top of these).
 */
export const DELIVERABILITY_PERMISSIONS = definePermissions({
  subjects: {
    MailSuppression: { actions: { read: [], create: [], delete: [] } },
  },
  systemJobs: [MAIL_INTAKE_JOB, MAIL_EVENTS_RETENTION_JOB],
});
