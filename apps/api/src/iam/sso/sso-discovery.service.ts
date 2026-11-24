import { Injectable } from '@nestjs/common';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SsoConnectionsRepository } from './sso-connections.repository.js';
import { SsoConnectionsService } from './sso-connections.service.js';
import { SsoDomainsRepository } from './sso-domains.repository.js';
import { emailDomain } from './sso-domains.service.js';

/** At most this many tenants are looked at for one domain (a domain is rarely shared). */
const MAX_TENANTS = 10;

/**
 * Home-realm discovery: the login URL of an enabled connection of an
 * active tenant that verified the address's domain (`sso_domain_routes`,
 * global, then that tenant's connections in its own scope). Only the
 * domain is read. Several (a domain two tenants verified, a tenant with
 * two connections): the tenant that verified it first, its oldest
 * connection, so the answer is stable.
 */
@Injectable()
export class SsoDiscovery {
  constructor(
    private readonly domains: SsoDomainsRepository,
    private readonly connectionRows: SsoConnectionsRepository,
    private readonly tenancy: Tenancy,
    private readonly connections: SsoConnectionsService,
  ) {}

  async loginUrl(email: string): Promise<string | null> {
    const domain = emailDomain(email.trim());
    if (!domain) {
      return null;
    }
    // Global: readable outside any tenant.
    const routes = await this.tenancy.run(null, () =>
      this.domains.routesOf(domain, MAX_TENANTS),
    );
    for (const { tenantId } of routes) {
      const tenant = await this.tenancy.find(tenantId);
      if (!tenant?.active) {
        continue;
      }
      const connection = await this.tenancy.run(tenantId, () =>
        this.connectionRows.oldestEnabled(tenantId),
      );
      if (connection) {
        return this.connections.urls(connection).login;
      }
    }
    return null;
  }
}
