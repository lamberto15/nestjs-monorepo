import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may manage webhooks for others (@nestjs/authorization): users, never while impersonating. */
@Policy()
export class WebhookPolicy {
  constructor(private readonly access: AccessService) {}

  async manageEndpoints(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageEndpoints', 'Webhooks')
    );
  }

  async manageSenders(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageSenders', 'Webhooks');
  }
}
