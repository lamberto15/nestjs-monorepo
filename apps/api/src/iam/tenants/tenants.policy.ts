import { Policy } from '@nestjs/authorization';
import { manager } from '../access/access.policy.js';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';

/**
 * Who administers tenants (@nestjs/authorization): users only, never while
 * acting as someone else. `manageTenants` routes are `@OperatorOnly()` too.
 */
@Policy()
export class TenantsPolicy {
  constructor(private readonly access: AccessService) {}

  async manageTenants(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTenants', 'Access');
  }

  async manageDomains(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageDomains', 'Access');
  }
}
