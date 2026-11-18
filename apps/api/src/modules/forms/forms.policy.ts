import { Policy } from '@nestjs/authorization';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who does what with forms (forms.permissions.ts): four independent rights. */
@Policy()
export class FormPolicy {
  constructor(private readonly access: AccessService) {}

  read(user: Principal | null) {
    return this.access.can(user, 'read', 'Form');
  }

  submit(user: Principal | null) {
    return this.access.can(user, 'submit', 'Form');
  }

  edit(user: Principal | null) {
    return this.access.can(user, 'edit', 'Form');
  }

  /**
   * Answers are a person's: never through break-glass, though an operator
   * reading through a grant holds every read action of the catalog.
   */
  async readResponses(user: Principal | null) {
    if (user?.kind === 'user' && user.breakGlass) return false;
    return this.access.can(user, 'readResponses', 'Form');
  }
}
