import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who exports, previews and applies configuration bundles (@nestjs/authorization): users only, never while impersonating. */
@Policy()
export class ConfigBundlePolicy {
  constructor(private readonly access: AccessService) {}

  async export(user: Principal | null) {
    return manager(user) && this.access.can(user, 'export', 'ConfigBundle');
  }

  /** Previewing is applying's dry run: the same permission. */
  async apply(user: Principal | null) {
    return manager(user) && this.access.can(user, 'apply', 'ConfigBundle');
  }
}
