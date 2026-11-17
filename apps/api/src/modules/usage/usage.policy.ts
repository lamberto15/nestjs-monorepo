import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who reads API clients' usage and sets their quotas (@nestjs/authorization): users only, never while acting as someone else. */
@Policy()
export class UsagePolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return manager(user) && this.access.can(user, 'read', 'Usage');
  }

  async setClientQuota(user: Principal | null) {
    return manager(user) && this.access.can(user, 'setClientQuota', 'Usage');
  }
}
