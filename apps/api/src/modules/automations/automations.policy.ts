import { Policy } from '@nestjs/authorization';
import { manager, userOnly } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Users only. Configuring never while impersonating: a rule runs as whoever
 * activates it, who must have chosen to.
 */
@Policy()
export class AutomationRulePolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return userOnly(user) && this.access.can(user, 'read', 'AutomationRule');
  }

  async configure(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'configure', 'AutomationRule')
    );
  }
}
