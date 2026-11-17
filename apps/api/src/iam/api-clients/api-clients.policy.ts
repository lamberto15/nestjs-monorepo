import { Policy } from '@nestjs/authorization';
import { AccessService } from '../access/access.service.js';
import { manager } from '../access/access.policy.js';
import type { Principal } from '../auth/principal.js';

/** Who may manage API clients and their keys (@nestjs/authorization): `Access.manageClients`. */
@Policy()
export class ApiClientPolicy {
  constructor(private readonly access: AccessService) {}

  async manageClients(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageClients', 'Access');
  }
}
