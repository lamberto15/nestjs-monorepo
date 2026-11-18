import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/**
 * Who sees a subject's custom field definitions: whoever may read the
 * subject (clients build forms and tables from them), and whoever manages
 * them. Changing them is `Access.manageCustomFields`, for users only and
 * never while impersonating.
 */
@Policy()
export class CustomFieldPolicy {
  constructor(private readonly access: AccessService) {}

  async manageCustomFields(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageCustomFields', 'Access')
    );
  }

  async read(user: Principal | null, subject: string) {
    return (
      (await this.access.can(user, 'read', subject)) ||
      this.manageCustomFields(user)
    );
  }
}
