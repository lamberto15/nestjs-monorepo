import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who reads the tenant's quotas and who sets limits and plans (@nestjs/authorization). */
@Policy()
export class QuotaPolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return this.access.can(user, 'read', 'Quota');
  }

  /** Users only, never while acting as someone else. */
  async setLimits(user: Principal | null) {
    return manager(user) && this.access.can(user, 'setLimits', 'Quota');
  }
}
