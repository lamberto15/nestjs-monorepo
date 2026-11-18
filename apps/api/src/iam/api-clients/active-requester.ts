import { Injectable } from '@nestjs/common';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { ApiClientsService } from './api-clients.service.js';
import type { RequestPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';

/**
 * The principal a queued job acts for, as they are now: a job checks it
 * again before it does anything in their name. Called in the job's tenant
 * (TenantWorkerHost restored it): the principal must have queued it there,
 * a user must still be an active member, an API client still active.
 * Null when they are not: the job then fails without retries.
 */
@Injectable()
export class ActiveRequester {
  constructor(
    private readonly tenancy: Tenancy,
    private readonly users: UsersRepository,
    private readonly clients: ApiClientsService,
  ) {}

  async of(principal: RequestPrincipal): Promise<RequestPrincipal | null> {
    const tenantId = this.tenancy.tenantId();
    if (principal.tenantId !== tenantId) return null;
    if (principal.kind === 'user') {
      const user = await this.users.inTenant(principal.id, tenantId);
      if (!user) return null;
      // Started while impersonating: the audit keeps who really did it.
      return principal.impersonator
        ? { ...user, impersonator: principal.impersonator }
        : user;
    }
    if (principal.kind !== 'client') return null; // a payload is data: never the system principal
    const client = await this.clients.get(principal.id).catch(() => null);
    return client?.active ? { ...principal, name: client.name } : null;
  }
}
