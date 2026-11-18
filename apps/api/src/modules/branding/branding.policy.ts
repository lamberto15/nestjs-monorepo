import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who changes the branding (@nestjs/authorization): users only, never while impersonating. */
@Policy()
export class BrandingPolicy {
  constructor(private readonly access: AccessService) {}

  async update(user: Principal | null) {
    return manager(user) && this.access.can(user, 'update', 'Branding');
  }
}
