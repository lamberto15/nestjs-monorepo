import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * The routes' permission checks. Approval.read, cancel and abandon are
 * checked on the request itself (ApprovalsService: a SQL filter for lists,
 * the row for one).
 */
@Policy()
export class ApprovalsPolicy {
  constructor(private readonly access: AccessService) {}

  /** Policies: users only, never while impersonating. */
  async managePolicies(user: Principal | null) {
    return manager(user) && this.access.can(user, 'managePolicies', 'Approval');
  }
}
