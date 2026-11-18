import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may see the keys' state and start the re-encryption: `Access.manageEncryption`. */
@Policy()
export class EncryptionAdminPolicy {
  constructor(private readonly access: AccessService) {}

  manageEncryption(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageEncryption', 'Access');
  }
}
