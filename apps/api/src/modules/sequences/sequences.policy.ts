import { Policy } from '@nestjs/authorization';
import { manager } from '../../iam/access/access.policy.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';

/** Who may define naming series: `Access.manageNamingSeries`. Reading them needs no permission. */
@Policy()
export class NamingSeriesPolicy {
  constructor(private readonly access: AccessService) {}

  async manageNamingSeries(user: Principal | null) {
    return (
      manager(user) && this.access.can(user, 'manageNamingSeries', 'Access')
    );
  }
}
