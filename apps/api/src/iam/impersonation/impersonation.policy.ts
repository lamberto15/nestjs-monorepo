import { Policy } from '@nestjs/authorization';
import { manager } from '../access/access.policy.js';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';

/** Who may act as a member (@nestjs/authorization): never while already acting as one. */
@Policy()
export class ImpersonationPolicy {
  constructor(private readonly access: AccessService) {}

  async impersonate(user: Principal | null) {
    return manager(user) && this.access.can(user, 'impersonate', 'Access');
  }
}
