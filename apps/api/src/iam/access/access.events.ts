import type { ClientPrincipal, UserPrincipal } from '../auth/principal.js';

/**
 * What access tells the rest of the app (@nestjs/event-emitter, emitted
 * with `emitAsync()` and awaited, inside the change's transaction): a
 * listener that must not fail silently declares
 * `@OnEvent(name, { suppressErrors: false })`, and its error rolls the
 * change back.
 */
export const ACCESS_EVENTS = {
  /**
   * A membership was deactivated: what waits on the member (approvals,
   * delegations) moves on, and their sessions in the tenant may end (the
   * membership check refuses them from the next request anyway).
   */
  memberDeactivated: 'access.member-deactivated',
  /**
   * An administrator turned a membership back on: iam/sso reactivates the
   * account its SCIM deprovisioning deactivated (no active membership was
   * left), in the change's transaction.
   */
  memberReactivated: 'access.member-reactivated',
  /**
   * Cached abilities were dropped on this instance (AccessService.clear():
   * a change to roles, grants or unit memberships, here or on another
   * instance). Unlike the others: emitted with `emit()` on every instance,
   * after the change committed, with no payload (which principal changed is
   * not known). modules/realtime re-checks its impersonation sockets.
   */
  abilitiesChanged: 'access.abilities-changed',
} as const;

export interface MemberDeactivatedEvent {
  userId: string;
  tenantId: string;
  /** An administrator, or the IdP's API client (SCIM). */
  actor: UserPrincipal | ClientPrincipal;
}

export interface MemberReactivatedEvent {
  userId: string;
  tenantId: string;
  actor: UserPrincipal;
  ip?: string;
}
