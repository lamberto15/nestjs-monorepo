import { Injectable } from '@nestjs/common';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';
import { DataTransferRepository } from './data-transfer.repository.js';

/**
 * A principal a job carries (data, possibly days old), as it is now in a
 * tenant: the user while their account and membership are active, the
 * client while it is; null otherwise. A transfer and a scheduled report run
 * only for one that still acts there.
 */
@Injectable()
export class PrincipalNow {
  constructor(
    private readonly repository: DataTransferRepository,
    private readonly users: UsersRepository,
  ) {}

  async of(
    kind: string,
    id: string,
    tenantId: string,
  ): Promise<RequestPrincipal | null> {
    if (kind === 'user') {
      const user = await this.users.inTenant(id, tenantId);
      return user?.tenantId === tenantId ? user : null;
    }
    if (kind !== 'client') return null;
    const client = await this.repository.findClient(id);
    return client?.active
      ? { kind: 'client', id, name: client.name, tenantId }
      : null;
  }
}
