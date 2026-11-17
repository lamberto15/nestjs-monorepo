import { Policy } from '@nestjs/authorization';
import { manager } from '../access/access.policy.js';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';

/** Who may open break-glass grants: an operator's own session, never an impersonation. */
@Policy()
export class BreakGlassPolicy {
  constructor(private readonly access: AccessService) {}

  async breakGlass(user: Principal | null) {
    return manager(user) && this.access.can(user, 'breakGlass', 'Platform');
  }
}
