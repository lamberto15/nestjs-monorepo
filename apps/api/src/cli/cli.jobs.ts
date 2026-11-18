import {
  definePermissions,
  defineSystemJob,
} from '../iam/access/permissions.js';

/**
 * The operator CLI (`pnpm ops`): the break-glass path into a deployment,
 * run on a server by someone who holds its environment. The actor of
 * everything it writes is the system principal `system:ops`; each audit
 * entry also names the operator's OS user and host (`details.operator`).
 * `permissions: []`: the commands go through the services of iam and core,
 * never through a check a request's principal would pass.
 */
export const OPS_JOB = defineSystemJob({ key: 'ops', permissions: [] });

/** Its declaration, registered by CliModule. */
export const CLI_PERMISSIONS = definePermissions({
  subjects: {},
  systemJobs: [OPS_JOB],
});
