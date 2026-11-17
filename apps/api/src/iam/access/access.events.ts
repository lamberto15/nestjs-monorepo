import type { UserPrincipal } from '../auth/principal.js';

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
} as const;

export interface MemberDeactivatedEvent {
  userId: string;
  tenantId: string;
  actor: UserPrincipal;
}
