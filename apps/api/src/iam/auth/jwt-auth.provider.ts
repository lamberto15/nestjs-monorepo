import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  JwtBearerProvider,
  type JwtClaims,
} from '@nestjs/authentication';
import { z } from 'zod';
import { DrizzleAuthenticationStore } from './drizzle-authentication.store.js';
import type { RequestPrincipal } from './principal.js';
import { UsersRepository } from './users.repository.js';

/** A user's id: anything else (`system:…`, a typo) is no one, not a database error. */
const uuid = z.uuid();

/**
 * Users of token clients (mobile apps, CLIs): `Authorization: Bearer <JWT>`,
 * verified with the `accessToken` options (HS256, the key from core/secrets
 * or JWT_SECRET). The user is loaded on every request, so a deactivated
 * account stops at once. Last in the chain (order 2). Issuing tokens (a
 * token sign-in route) is the account module's: `TokenService.issue()`
 * with `tokenClaims()`.
 */
@Injectable()
export class JwtAuth extends JwtBearerProvider<RequestPrincipal> {
  constructor(
    private readonly accounts: UsersRepository,
    private readonly store: DrizzleAuthenticationStore,
    registry: AuthenticationRegistry,
  ) {
    super({ realm: 'api' });
    // After sessions (0) and API keys (1).
    registry.registerProvider(this, { order: 2 });
  }

  // The tenant is the token's (`tid`, fixed for its refresh family), while
  // the membership in it is active.
  validate({ sub, tid }: JwtClaims) {
    return sub && uuid.safeParse(sub).success
      ? this.accounts.inTenant(
          sub,
          typeof tid === 'string' && uuid.safeParse(tid).success ? tid : null,
        )
      : null;
  }

  /**
   * Whether the refresh family these claims come from (their `sid`,
   * tokenClaims()) was revoked. Not asked on requests: an access token
   * lives until it expires. A realtime handshake asks: a socket outlives
   * its access token. A token without a `sid` is not known revoked.
   */
  async familyRevoked(claims: JwtClaims): Promise<boolean> {
    const { sub, sid } = claims;
    return typeof sub === 'string' && typeof sid === 'string'
      ? this.store.isTokenSessionRevoked(sub, sid)
      : false;
  }
}
