import { Policy } from '@nestjs/authorization';
import { manager } from '../access/access.policy.js';
import { AccessService } from '../access/access.service.js';
import type { Principal } from '../auth/principal.js';

/** Who reads the audit log and the sign-in log: `Access.readAudit`. */
@Policy()
export class AuditPolicy {
  constructor(private readonly access: AccessService) {}

  async readAudit(user: Principal | null) {
    return manager(user) && this.access.can(user, 'readAudit', 'Access');
  }
}
