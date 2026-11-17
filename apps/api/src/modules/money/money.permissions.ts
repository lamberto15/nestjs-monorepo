import {
  definePermissions,
  defineSystemJob,
} from '../../iam/access/permissions.js';

/** The ECB fetch, run as `system:exchange-rates`: it touches only the global rates table, so it needs no permission. */
export const EXCHANGE_RATES_JOB = defineSystemJob({
  key: 'exchange-rates',
  permissions: [],
});

export const MONEY_PERMISSIONS = definePermissions({
  systemJobs: [EXCHANGE_RATES_JOB],
});
