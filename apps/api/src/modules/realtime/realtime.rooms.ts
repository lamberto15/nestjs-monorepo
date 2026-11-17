import {
  assertRequestPrincipal,
  principalKey,
  type Principal,
} from '../../iam/auth/principal.js';

/** Every connection acting in a tenant. */
export const tenantRoom = (tenantId: string) => `tenant:${tenantId}`;

/**
 * The room of a principal in a tenant: every connection of that user or API
 * client acting in that tenant. A user in two tenants has a room in each and
 * a connection is in its session's tenant's only, so an event of tenant A
 * never reaches a socket opened in tenant B. `tenantId` null: the account
 * room of a user, for what is the person's own whatever the tenant (a
 * security notice sent outside any tenant). The system principal never
 * connects: refused.
 */
export function principalRoom(
  principal: Pick<Principal, 'kind' | 'id'>,
  tenantId: string | null,
) {
  assertRequestPrincipal(principal as Principal, 'A realtime room');
  return tenantId
    ? `tenant:${tenantId}:principal:${principalKey(principal)}`
    : `principal:${principalKey(principal)}`;
}

/** A private room for the browser session that opened a socket. */
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/** A private room for the refresh family whose access token opened a socket: its `sid` claim. */
export const tokenRoom = (tokenSessionId: string) => `token:${tokenSessionId}`;

/** A private room for the API key that opened a socket: its public id (`sk_<id>_…`). */
export const keyRoom = (keyId: string) => `key:${keyId}`;
