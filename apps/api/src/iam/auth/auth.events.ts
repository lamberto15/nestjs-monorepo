import type { ClientPrincipal, UserPrincipal } from './principal.js';

/**
 * What auth tells the rest of the app (@nestjs/event-emitter, emitted with
 * `emitAsync()` and awaited): the audit log records them (AuditModule),
 * others (realtime, security alerts) may listen too. Auth imports none of
 * its listeners. A listener that must not fail silently declares
 * `@OnEvent(name, { suppressErrors: false })`: its error then fails the
 * request that emitted the event, as a failed audit write should.
 */
export const AUTH_EVENTS = {
  /** A password sign-in succeeded (the session exists; a second factor may be pending). */
  signedIn: 'auth.signed-in',
  /** A sign-in was refused: wrong password, or no such account. */
  signInFailed: 'auth.sign-in-failed',
  /** A browser session ended (sign-out, revocation). */
  sessionEnded: 'auth.session-ended',
  /** A token family ended: its access tokens' `sid`. */
  tokenSessionEnded: 'auth.token-session-ended',
  /** An API client's key was used from outside its allowlist (once per address and hour). */
  clientIpDenied: 'auth.client-ip-denied',
} as const;

export interface SignedInEvent {
  user: UserPrincipal;
  /** `password`, `magic-link`, `oidc:google`… */
  method: string;
  ip: string;
  userAgent?: string;
  /** The tenant the session acts in, null for none. */
  tenantId: string | null;
}

export interface SignInFailedEvent {
  /** The address as typed: the label of the anonymous audit entry. */
  email: string;
  /** The account the address is, when there is one: its tenant's log gets an entry too. */
  user?: UserPrincipal;
  method: string;
  ip: string;
}

export interface SessionEndedEvent {
  sessionId: string;
}

export interface TokenSessionEndedEvent {
  /** The `sid` claim of the family's access tokens. */
  sid: string;
}

export interface ClientIpDeniedEvent {
  client: ClientPrincipal;
  ip: string | undefined;
}
