import { definePermissions, defineSystemJob } from './permissions.js';

/** AccessSeeder: the first tenant, its roles and its first administrator, on a deployment's first start. */
export const SEED_JOB = defineSystemJob({ key: 'seed', permissions: [] });

/**
 * What access itself declares (registered by AccessModule): who may run
 * access control, the first-boot seed's job, and the roles every tenant
 * starts with besides Administrator (each module adds its grants to them
 * by key: `editor`, `unit-lead`, `viewer`). The other `Access.*`
 * actions are declared by the modules whose routes they guard.
 */
export const ACCESS_PERMISSIONS = definePermissions({
  subjects: {
    Access: {
      actions: {
        manageRoles: [],
        // Never passwords: an administrator manages the membership, not the account.
        manageUsers: [],
      },
    },
  },
  systemJobs: [SEED_JOB],
  seedRoles: [
    { key: 'editor', permissions: [] },
    { key: 'unit-lead', permissions: [] },
    { key: 'viewer', permissions: [] },
  ],
});
