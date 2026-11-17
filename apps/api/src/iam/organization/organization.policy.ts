import { Policy } from '@nestjs/authorization';
import { AccessService } from '../access/access.service.js';
import { manager } from '../access/access.policy.js';
import type { Principal } from '../auth/principal.js';

/** Who may change the unit tree (@nestjs/authorization): `Access.manageOrganizationalUnits`. */
@Policy()
export class OrganizationPolicy {
  constructor(private readonly access: AccessService) {}

  async manageOrganizationalUnits(user: Principal | null) {
    return (
      manager(user) &&
      this.access.can(user, 'manageOrganizationalUnits', 'Access')
    );
  }
}
