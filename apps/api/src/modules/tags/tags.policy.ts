import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may define tags: `Access.manageTags`. */
@Policy()
export class TagsPolicy {
  constructor(private readonly access: AccessService) {}

  async manageTags(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageTags', 'Access');
  }
}
