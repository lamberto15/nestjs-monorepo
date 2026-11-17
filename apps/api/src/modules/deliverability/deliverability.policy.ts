import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** The suppression list: who reads and changes it (users only, never while acting as someone else). */
@Policy()
export class MailSuppressionPolicy {
  constructor(private readonly access: AccessService) {}

  async read(user: Principal | null) {
    return manager(user) && this.access.can(user, 'read', 'MailSuppression');
  }

  async create(user: Principal | null) {
    return manager(user) && this.access.can(user, 'create', 'MailSuppression');
  }

  async delete(user: Principal | null) {
    return manager(user) && this.access.can(user, 'delete', 'MailSuppression');
  }
}
