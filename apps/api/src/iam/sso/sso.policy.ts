import { Policy } from '@nestjs/authorization';
import { AccessService } from '../access/access.service.js';
import { manager } from '../access/access.policy.js';
import type { Principal } from '../auth/principal.js';

/** Who may run enterprise sign-on (@nestjs/authorization). */
@Policy()
export class SsoPolicy {
  constructor(private readonly access: AccessService) {}

  /** The tenant's connections, domains and "SSO required": `Access.manageSso`, users only. */
  async manageSso(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageSso', 'Access');
  }

  /** The SCIM routes: an API client (the IdP's token) holding `Access.provisionScim`. */
  async provisionScim(user: Principal | null) {
    return (
      user?.kind === 'client' &&
      this.access.can(user, 'provisionScim', 'Access')
    );
  }
}
