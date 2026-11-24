import { Injectable, NotFoundException } from '@nestjs/common';
import { OidcService, SessionService } from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditService } from '../audit/audit.service.js';
import { AUTH_EVENTS, type SignedInEvent } from '../auth/auth.events.js';
import { sessionTenant } from '../auth/impersonation.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AccountFlowContext } from './account-flow.context.js';
import { AccountRepository } from './account.repository.js';
import { AccountWork } from './account-work.js';
import {
  ProviderReauthentications,
  ReauthenticationRefused,
  reauthenticationUrl,
} from './oidc-reauthentication.js';
import { assertNotLastSignInMethod } from './sign-in-methods.js';

/** The request a provider's callback came with. */
export interface CallbackRequest {
  ip: string;
  userAgent: string | undefined;
}

/**
 * Signing in with a provider in a browser, stepping up through one, and
 * the providers connected to the account. The package (OidcService) does
 * the protocol: PKCE, nonce, state bound to the browser, the code's
 * exchange, the account's resolution (OidcAccounts) and the sign-in.
 */
@Injectable()
export class ProviderSignIn {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
    private readonly users: UsersRepository,
    private readonly audit: AuditService,
    private readonly work: AccountWork,
    private readonly signInContext: SignInContext,
    private readonly flow: AccountFlowContext,
    private readonly providerReauthentications: ProviderReauthentications,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The OIDC callback: the package checks the state, exchanges the code,
   * resolves the account (OidcAccounts) and signs in, all inside
   * `finish()`; the context names the method for the session. The sign-in
   * is announced (`auth.signed-in`) as a password's is. Where to send the
   * browser.
   *
   * A step-up's callback (its `state` was remembered by
   * `startReauthentication()`) runs as one: OidcAccounts accepts only the
   * user who started it, freshly authenticated, else throws
   * ReauthenticationRefused (no sign-in happens; the route sends the
   * browser back with an error). Audited either way, as the user's
   * `auth.reauthenticated` or `auth.reauthentication-failed`
   * (`method: oidc`).
   *
   * The marker is read, and forgotten only once the callback was judged:
   * a request that fails the package's checks (another client with a state
   * it learnt, without this browser's transaction cookie) leaves it in
   * place. `stepUpExpected` (the browser carries the step-up cookie for
   * this state): without a marker, the callback is refused (`expired`),
   * never finished as a plain sign-in, which would skip the same-user and
   * freshness checks.
   */
  async signIn(
    provider: string,
    query: Record<string, string | undefined>,
    request: CallbackRequest,
    { stepUpExpected = false }: { stepUpExpected?: boolean } = {},
  ) {
    const reauthenticating = await this.providerReauthentications.peek(
      query.state,
    );
    const finish = async () => {
      const { result } = await this.flow.run({ reauthenticating }, () =>
        this.signInContext.run(`oidc:${provider}`, () =>
          this.oidc.finish(provider, query),
        ),
      );
      await this.announce(result.cookies[0], provider, request);
      return result;
    };
    if (!reauthenticating) {
      if (stepUpExpected) {
        await this.work.run(() =>
          this.audit.record(null, {
            action: 'auth.reauthentication-failed',
            details: { method: 'oidc', provider, reason: 'expired' },
            ip: request.ip,
          }),
        );
        throw new ReauthenticationRefused('expired');
      }
      return finish();
    }
    const user = await this.users.findActive(reauthenticating.userId);
    const audited = (action: string, details: Record<string, unknown>) =>
      this.work.run(() =>
        this.audit.record(user, {
          action,
          targetType: 'user',
          targetId: reauthenticating.userId,
          details: { method: 'oidc', provider, ...details },
          ip: request.ip,
        }),
      );
    try {
      const redirect = await finish();
      await this.providerReauthentications.forget(query.state);
      await audited('auth.reauthenticated', {});
      return redirect;
    } catch (error) {
      if (error instanceof ReauthenticationRefused) {
        await this.providerReauthentications.forget(query.state);
        await audited('auth.reauthentication-failed', {
          reason: error.reason,
        });
      }
      throw error;
    }
  }

  /**
   * `auth.signed-in` for the session `finish()` made (its cookie): the
   * package signs in inside it, so the user is read back from the session.
   */
  private async announce(
    cookie: string | undefined,
    provider: string,
    request: CallbackRequest,
  ) {
    const pair = cookie?.split(';')[0];
    const session = pair
      ? await this.sessions.validate(
          this.sessions.tokenFrom({ headers: { cookie: pair } }),
        )
      : null;
    const user = session && (await this.users.findActive(session.userId));
    if (!session || !user) {
      return;
    }
    await this.events.emitAsync(AUTH_EVENTS.signedIn, {
      user,
      method: `oidc:${provider}`,
      ip: request.ip,
      userAgent: request.userAgent,
      tenantId: sessionTenant(session),
    } satisfies SignedInEvent);
  }

  /**
   * A step-up through a provider, for the signed-in `user`: the package's
   * login, its authorization URL asking the provider to authenticate the
   * user again (`prompt=login`, `max_age=0`), and the login's `state`
   * remembered as a step-up of this user, from now.
   */
  async startReauthentication(
    user: UserPrincipal,
    provider: string,
    redirectTo: string | undefined,
  ) {
    const redirect = await this.oidc.start(provider, { redirectTo });
    const url = reauthenticationUrl(redirect.url);
    const state = url.searchParams.get('state');
    if (!state) {
      throw new Error(`OidcService.start(${provider}) answered no state`);
    }
    await this.providerReauthentications.remember(state, {
      userId: user.id,
      startedAt: Date.now(),
      tenantId: user.tenantId ?? null,
      ...(redirectTo !== undefined && { redirectTo }),
    });
    return { ...redirect, url: url.toString() };
  }

  /** The providers connected to the account. */
  async identities(userId: string) {
    const rows = await this.accounts.identitiesOf(userId);
    return rows.map((row) => ({
      provider: row.provider,
      email: row.email,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * Disconnects a provider, unless it's the last way to sign in (no
   * password, no passkey, no other provider): 409 `last_sign_in_method`.
   * The account row is locked first (`signInMethods()`), so two
   * removals at once can't each see "one left" and remove both.
   */
  async unlink(user: UserPrincipal, provider: string) {
    await this.work.run(async () => {
      if (!(await this.accounts.hasIdentity(user.id, provider))) {
        throw new NotFoundException();
      }
      assertNotLastSignInMethod(await this.accounts.signInMethods(user.id));
      if (!(await this.accounts.deleteIdentity(user.id, provider))) {
        throw new NotFoundException();
      }
      await this.audit.record(user, {
        action: 'user.identity-unlinked',
        targetType: 'user',
        targetId: user.id,
        details: { provider },
      });
    });
  }
}
