import { Policy } from '@nestjs/authorization';
import { AccessService } from '../access/access.service.js';
import { manager } from '../access/access.policy.js';
import type { Principal } from '../auth/principal.js';

/** Who may place, list and release legal holds: `Access.manageLegalHolds`. */
@Policy()
export class LegalHoldPolicy {
  constructor(private readonly access: AccessService) {}

  async manageLegalHolds(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageLegalHolds', 'Access');
  }
}
