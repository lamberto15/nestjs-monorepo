import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { apiClients } from '../../iam/auth/auth.tables.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { UsersRepository } from '../../iam/auth/users.repository.js';

/**
 * A principal a job carries (data, possibly days old), as it is now in a
 * tenant: the user while their account and membership are active, the
 * client while it is; null otherwise. A transfer and a scheduled report run
 * only for one that still acts there.
 */
@Injectable()
export class PrincipalNow {
  constructor(
    @InjectTransaction() private readonly db: Database,
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
    const [client] = await this.db
      .select()
      .from(apiClients)
      .where(eq(apiClients.id, id));
    return client?.active
      ? { kind: 'client', id, name: client.name, tenantId }
      : null;
  }
}
