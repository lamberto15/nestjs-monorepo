import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may create, change and delete business calendars: `Access.manageCalendars`. */
@Policy()
export class CalendarPolicy {
  constructor(private readonly access: AccessService) {}

  async manageCalendars(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageCalendars', 'Access');
  }
}
