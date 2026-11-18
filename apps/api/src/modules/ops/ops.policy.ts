import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may look at and steer the background work: users only, never while impersonating. */
@Policy()
export class OpsPolicy {
  constructor(private readonly access: AccessService) {}

  viewOps(user: Principal | null) {
    return manager(user) && this.access.can(user, 'viewOps', 'Access');
  }

  pauseQueues(user: Principal | null) {
    return manager(user) && this.access.can(user, 'pauseQueues', 'Access');
  }

  retryJobs(user: Principal | null) {
    return manager(user) && this.access.can(user, 'retryJobs', 'Access');
  }

  testIntegrations(user: Principal | null) {
    return manager(user) && this.access.can(user, 'testIntegrations', 'Access');
  }

  discardJobs(user: Principal | null) {
    return manager(user) && this.access.can(user, 'discardJobs', 'Access');
  }
}
