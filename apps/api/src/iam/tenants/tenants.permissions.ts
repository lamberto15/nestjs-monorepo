import { definePermissions, defineSystemJob } from '../access/permissions.js';

/** The nightly erase of tenants whose deletion's grace period ended. */
export const TENANT_DELETION_JOB = defineSystemJob({
  key: 'tenant-deletion',
  permissions: [],
});

/** The nightly sweep of tenants made by sign-ups nobody verified. */
export const SIGN_UP_SWEEP_JOB = defineSystemJob({
  key: 'sign-up-tenant-sweep',
  permissions: [],
});

/** The DNS checks of tenants' domains. */
export const TENANT_DOMAINS_JOB = defineSystemJob({
  key: 'tenant-domains',
  permissions: [],
});

/**
 * What the tenants module adds to the catalog: the operators' tenant
 * administration (in the operators' tenant only, `@OperatorOnly()` on top)
 * and a tenant's own domains.
 */
export const TENANT_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageTenants: [], manageDomains: [] } },
  },
  systemJobs: [TENANT_DELETION_JOB, SIGN_UP_SWEEP_JOB, TENANT_DOMAINS_JOB],
});
