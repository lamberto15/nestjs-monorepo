import { sql } from 'drizzle-orm';
import { refreshTokens } from './auth.tables.js';

/**
 * The `sid` claim a refresh family's tokens carry (tokenClaims()), from the
 * claims the family keeps; null for a family signed in before it existed.
 * What a revocation reports (`auth.token-session-ended`): the realtime
 * room of the family's sockets.
 */
export const tokenSessionId = sql<
  string | null
>`${refreshTokens.claims} ->> 'sid'`;

/**
 * The sign-in method a refresh family's tokens carry (tokenClaims()'s
 * `method`: `sso:<connection>`, `oidc:google`), from the claims the family
 * keeps; null for a password or passkey sign-in (`amr` says those).
 */
export const tokenSignInMethod = sql<
  string | null
>`${refreshTokens.claims} ->> 'method'`;

/** The `sid`s of revoked rows, each once (a family has a row per rotation). */
export const distinctTokenSessionIds = (rows: { sid: string | null }[]) => [
  ...new Set(
    rows.flatMap(({ sid }) => (typeof sid === 'string' && sid ? [sid] : [])),
  ),
];
