import { definePermissions, defineSystemJob } from '../access/permissions.js';

/** SsoProcessor: connections' discovery documents and domains' DNS records, as `system:sso`. */
export const SSO_JOB = defineSystemJob({ key: 'sso', permissions: [] });

/**
 * What enterprise sign-on adds to the catalog: who sets up a tenant's
 * single sign-on, the SCIM token's action, and the job.
 */
export const SSO_PERMISSIONS = definePermissions({
  subjects: {
    Access: { actions: { manageSso: [], provisionScim: [] } },
  },
  systemJobs: [SSO_JOB],
});
