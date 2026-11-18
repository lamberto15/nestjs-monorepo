import { Policy } from '@nestjs/authorization';
import { manager } from '../access/access.policy.js';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';

/** Who reads and changes the tenant's sign-in policy: users, never while impersonating. */
@Policy()
export class AuthPolicyPolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return manager(user) && this.access.can(user, 'readAuthPolicy', 'Access');
  }

  /** The operators' platform value: `Access.managePlatformAuthPolicy` (the routes are `@OperatorOnly()` too). */
  async managePlatform(user: Principal | null) {
    return (
      manager(user) &&
      this.access.can(user, 'managePlatformAuthPolicy', 'Access')
    );
  }

  async update(user: Principal | null) {
    return manager(user) && this.access.can(user, 'updateAuthPolicy', 'Access');
  }
}
