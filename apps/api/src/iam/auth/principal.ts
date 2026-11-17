/** A user: signed in with a session cookie, or an access token. */
export interface UserPrincipal {
  kind: 'user';
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  /** The language they chose, or null (the request's). */
  locale: string | null;
  /** Their IANA time zone, or null (the app's). */
  timezone: string | null;
  /**
   * The tenant this user acts in: the session's (or the token's `tid`),
   * while the membership in it, the tenant and the account are active; null
   * when there is none. Every query of the request runs in it
   * (PrincipalGuard enters it).
   */
  tenantId: string | null;
  /**
   * Set (only while something is pending) on the first administrator until
   * they replaced the placeholder address and the generated password
   * (OnboardingGuard).
   */
  onboarding?: { email: boolean; password: boolean };
  /** Set while an administrator acts as this user (SessionAuth checks it on every request). */
  impersonator?: { id: string; email: string };
}

/** A system calling the API with its key (an API client). */
export interface ClientPrincipal {
  kind: 'client';
  id: string;
  name: string;
  /** The one tenant the client belongs to and acts in. */
  tenantId: string;
}

/** Marks a system principal made in code (`systemPrincipal()`): data (JSON, a token, a job payload) can't carry it. */
const SYSTEM = Symbol('system-principal');

/**
 * The application itself, running a declared job without a user (a cron
 * job, a seed). Its `id` is the job's key, so `principalKey()` is
 * `system:<job>`. Made only in code; never over HTTP or a socket
 * (PrincipalGuard refuses it), never stored or queued.
 */
export interface SystemPrincipal {
  kind: 'system';
  /** The job's key (`audit-retention`). */
  id: string;
  /** How the audit log shows it: `System: Audit retention`. */
  name: string;
  readonly [SYSTEM]: true;
}

/** Who a request or a socket acts as: what authentication can produce. `null` is a guest. */
export type RequestPrincipal = UserPrincipal | ClientPrincipal;

/** Who acts: a request's principal, or the system running a job. */
export type Principal = RequestPrincipal | SystemPrincipal;

/** The system principal of a job. */
export const systemPrincipal = (job: {
  key: string;
  label: string;
}): SystemPrincipal => ({
  kind: 'system',
  id: job.key,
  name: `System: ${job.label}`,
  [SYSTEM]: true,
});

/**
 * Whether this is a system principal made in code: `kind: 'system'` read
 * from data (a forged token, a deserialized job) is not one.
 */
export const isSystemPrincipal = (
  principal: unknown,
): principal is SystemPrincipal =>
  (principal as Partial<SystemPrincipal> | null)?.kind === 'system' &&
  (principal as Partial<SystemPrincipal>)[SYSTEM] === true;

/**
 * The principal as one string, `user:<id>`, `client:<id>` or
 * `system:<job>`: an owner, a scope, an audit actor.
 */
export const principalKey = (principal: Pick<Principal, 'kind' | 'id'>) =>
  `${principal.kind}:${principal.id}`;

/**
 * How the principal appears in the audit log. An impersonated user's actions
 * are theirs, labelled with who really did them; the system's name the job.
 */
export const actorOf = (principal: Principal | null) =>
  principal
    ? {
        actor: principalKey(principal),
        actorLabel:
          principal.kind === 'user'
            ? principal.impersonator
              ? `${principal.impersonator.email} as ${principal.email}`
              : principal.email
            : principal.name,
      }
    : { actor: 'anonymous', actorLabel: 'anonymous' };

/**
 * Refuses the system principal where only a request's principal belongs
 * (a queued job's owner, an idempotency scope, a realtime room). Throws, as
 * a bug would be.
 */
export function assertRequestPrincipal(
  principal: Principal,
  where: string,
): asserts principal is RequestPrincipal {
  if (principal.kind === 'system') {
    throw new Error(
      `${where} takes a user or an API client, not the system principal (${principalKey(principal)}).`,
    );
  }
}
