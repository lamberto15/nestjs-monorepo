import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import { manager } from '../../iam/access/access.policy.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may turn retention rules on and off: `Access.manageRetention`. */
@Policy()
export class RetentionPolicy {
  constructor(private readonly access: AccessService) {}

  async manageRetention(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageRetention', 'Access');
  }
}
