import { Policy } from '@nestjs/authorization';
import type { Principal, UserPrincipal } from '../auth/principal.js';
import { AccessService } from './access.service.js';

/** For abilities only users may hold, whatever an API client's permissions say. */
export const userOnly = (user: Principal | null): user is UserPrincipal =>
  user?.kind === 'user';

/** Access management: users only, never while an administrator acts as someone else. */
export const manager = (user: Principal | null): user is UserPrincipal =>
  user?.kind === 'user' && !user.impersonator;

/**
 * Who may run access control (@nestjs/authorization): each ability asks
 * the principal's permissions (AccessService), so what a role may do
 * changes through the access API while the checks stay in code. A guest
 * (`null`) is denied everywhere. Each module keeps its own policy next to
 * its code; this one guards the access API.
 */
@Policy()
export class AccessPolicy {
  constructor(private readonly access: AccessService) {}

  async manageRoles(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageRoles', 'Access');
  }

  async manageUsers(user: Principal | null) {
    return manager(user) && this.access.can(user, 'manageUsers', 'Access');
  }

  /**
   * Why a member may or may not act on a subject or a record (GET
   * /v1/access/users/{id}/explanation): who hands out roles or manages users.
   */
  async explain(user: Principal | null) {
    return (await this.manageRoles(user)) || (await this.manageUsers(user));
  }

  /**
   * The access API's read routes (the catalog, roles, users, units,
   * principals): any permission of access administration, so whoever
   * manages units lists them, and whoever impersonates or reads the audit
   * log finds whom. The actions other modules declare (units, API clients,
   * impersonation, the audit log) count once they are registered; until
   * then they are held by administrators alone.
   */
  async open(user: Principal | null) {
    if (!manager(user)) return false;
    for (const action of [
      'manageRoles',
      'manageUsers',
      'manageOrganizationalUnits',
      'manageClients',
      'impersonate',
      'readAudit',
    ]) {
      if (await this.access.can(user, action, 'Access')) return true;
    }
    return false;
  }
}
