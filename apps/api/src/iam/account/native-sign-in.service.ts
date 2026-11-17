import {
  BadRequestException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AuthenticationError,
  MagicLinkService,
  OidcService,
  SessionService,
  TokenService,
} from '@nestjs/authentication';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { t } from '@nestjs/i18n';
import { httpConfig } from '../../core/http/http.config.js';
import { AuditService } from '../audit/audit.service.js';
import {
  AUTH_EVENTS,
  type SignedInEvent,
  type SignInFailedEvent,
} from '../auth/auth.events.js';
import {
  authenticationOf,
  tokenClaims,
} from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { SignInContext } from '../auth/sign-in-context.js';
import { UsersRepository } from '../auth/users.repository.js';
import { AccountFlowContext } from './account-flow.context.js';
import { accountConfig } from './account.config.js';
import { OidcAccounts } from './account.handlers.js';
import { AccountWork } from './account-work.js';
import { deviceLabel } from './devices.js';
import {
  type NativeAccountFlow,
  type NativeHandoff,
  NativeHandoffs,
  type NativeLogin,
} from './native-handoff.js';
import { nativeRedirect, verifiesChallenge } from './native-redirect.js';
import {
  ReauthenticationRefused,
  reauthenticationUrl,
} from './oidc-reauthentication.js';

/**
 * Sign-ins that end in a native app: a provider's login opened in the system
 * browser with an allow-listed `redirectUri` and a PKCE challenge, or a
 * magic link opened by the app, end with a one-time code instead of a
 * browser session; POST /auth/token/exchange turns it, with the verifier,
 * into tokens, with the same two-factor and tenant handling, audit and
 * new-device alert as POST /auth/token.
 *
 * A signed-in app links a provider, or steps up through one, the same way:
 * its token asks for a one-time ticket (`ticket()`) the system browser
 * opens, bound to the user, the token's session (`sid`), the purpose, the
 * redirect URI and the PKCE challenge; the callback's code works only for
 * that session (`complete()`), never as a sign-in.
 *
 * Custom: @nestjs/authentication's provider and magic-link sign-ins end in
 * a session cookie; it has no token result for them (RFC 8252's flow), and
 * its link flow needs a browser session, which a token-only app has not.
 * Its `finish()` and `consume()` always sign the browser in (0.1.6 has no
 * `signIn: false`): the session they make for a native login is
 * discarded at once and its cookie cleared (`discardSignIn()`).
 */
@Injectable()
export class NativeSignIn {
  constructor(
    private readonly handoffs: NativeHandoffs,
    private readonly tokens: TokenService,
    private readonly sessions: SessionService,
    private readonly users: UsersRepository,
    private readonly oidc: OidcService,
    private readonly magicLinks: MagicLinkService,
    private readonly signInContext: SignInContext,
    private readonly flow: AccountFlowContext,
    private readonly audit: AuditService,
    private readonly work: AccountWork,
    private readonly oidcAccounts: OidcAccounts,
    private readonly events: EventEmitter2,
    @Inject(accountConfig.KEY)
    private readonly config: ConfigType<typeof accountConfig>,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  /**
   * The native login a login route was asked for, checked before the flow
   * starts: undefined for a browser's (neither part), else both parts and
   * a `redirectUri` of NATIVE_REDIRECT_URIS, or 400.
   */
  nativeLogin({
    redirectUri,
    codeChallenge,
  }: {
    redirectUri?: string;
    codeChallenge?: string;
  }): NativeLogin | undefined {
    if (redirectUri === undefined && codeChallenge === undefined) {
      return undefined;
    }
    if (!redirectUri || !codeChallenge) {
      throw new BadRequestException(
        '`redirectUri` and `codeChallenge` go together.',
      );
    }
    if (!this.config.nativeRedirectUris.includes(redirectUri)) {
      throw new BadRequestException({
        code: 'redirect_uri_not_allowed',
        message: 'This redirect URI is not one of NATIVE_REDIRECT_URIS.',
      });
    }
    return { redirectUri, codeChallenge };
  }

  /** Remembers a native login under its flow's key (an OIDC `state`). */
  remember(key: string, login: NativeLogin) {
    return this.handoffs.startLogin(key, login);
  }

  /** The native login a callback's key names, if it is one. */
  login(key: unknown) {
    return this.handoffs.login(key);
  }

  /** Forgets it, once its callback was judged. */
  forget(key: unknown) {
    return this.handoffs.forgetLogin(key);
  }

  /**
   * A provider's callback for a native login: the package's checks and the
   * account's resolution; the session `finish()` made is discarded at once
   * (`cookies` to set: its cookie cleared). The URL that hands the app its
   * code. The login is forgotten once judged.
   */
  async finishProvider(
    provider: string,
    query: Record<string, string | undefined>,
    login: NativeLogin,
    ip?: string,
  ) {
    const method = `oidc:${provider}`;
    const { account } = login;
    if (account && account.provider !== provider) {
      await this.forget(query.state);
      throw new BadRequestException("Another provider than the ticket's.");
    }
    const finish = async () => {
      const { result, identity } = await this.flow.run(
        account?.purpose === 'link'
          ? { linking: { id: account.userId } }
          : account
            ? {
                reauthenticating: {
                  userId: account.userId,
                  startedAt: account.startedAt,
                  tenantId: account.tenantId,
                },
              }
            : {},
        () =>
          this.signInContext.run(method, async () => {
            const finished = await this.oidc.finish(provider, query);
            return {
              userId: await this.discardSignIn(finished.cookies[0]),
              authenticatedAt: this.signInContext.toldAuthenticatedAt(),
            };
          }),
      );
      return { ...result, identity };
    };
    let finished: Awaited<ReturnType<typeof finish>>;
    try {
      finished = await finish();
    } catch (error) {
      if (error instanceof ReauthenticationRefused) {
        await this.forget(query.state);
        await this.audited(
          account!,
          'auth.reauthentication-failed',
          { reason: error.reason },
          ip,
        );
      }
      throw error;
    }
    const { userId, authenticatedAt, identity } = finished;
    await this.forget(query.state);
    if (!userId) {
      throw new Error(`OidcService.finish(${provider}) resolved no account`);
    }
    if (account) {
      // The resolver links to, or re-authenticates, that user only.
      if (userId !== account.userId) {
        throw new Error('A native link or step-up resolved another account');
      }
      // A step-up's success is audited by complete(), once its second
      // factor checked out and its tokens exist.
    }
    const url = await this.handOff(login, {
      userId,
      method,
      authenticatedAt,
      ...(account && {
        account: {
          purpose: account.purpose,
          sid: account.sid,
          provider: account.provider,
          tenantId: account.tenantId,
          ...(identity && { identity }),
        },
      }),
    });
    return { url, cookies: [this.sessions.clearCookie()] };
  }

  /**
   * The user of the session a sign-in by the package just made (its
   * cookie, `name=value; …`), and the session deleted: a native login
   * ends in tokens, never in a browser session. Custom code: the package's
   * `finish()` and `consume()` have no way to skip the sign-in.
   */
  private async discardSignIn(cookie: string | undefined) {
    const pair = cookie?.split(';')[0];
    const session = pair
      ? await this.sessions.validate(
          this.sessions.tokenFrom({ headers: { cookie: pair } }),
        )
      : null;
    if (session) {
      await this.sessions.discard(session.id);
    }
    return session?.userId;
  }

  /** A step-up's verdict, as the browser's (ProviderSignIn): account-level, in no tenant's log. */
  private async audited(
    account: { userId: string; provider: string },
    action: string,
    details: Record<string, unknown>,
    ip: string | undefined,
  ) {
    const user = await this.users.findActive(account.userId);
    await this.work.run(() =>
      this.audit.record(user, {
        action,
        targetType: 'user',
        targetId: account.userId,
        details: {
          method: 'oidc',
          provider: account.provider,
          via: 'token',
          ...details,
        },
        ip,
      }),
    );
  }

  /** The URL that hands `login`'s app a code for this sign-in. */
  async handOff(
    login: NativeLogin,
    sign: Omit<NativeHandoff, 'codeChallenge' | 'authenticatedAt'> & {
      authenticatedAt?: Date | null;
    },
  ) {
    const { authenticatedAt, ...rest } = sign;
    const code = await this.handoffs.issueCode({
      ...rest,
      codeChallenge: login.codeChallenge,
      ...(authenticatedAt && { authenticatedAt: authenticatedAt.getTime() }),
    });
    return nativeRedirect(login.redirectUri, { code });
  }

  /**
   * Where a native login that failed sends the app: its URI with `?error=`
   * (by default `sign_in_failed`, or a ticket's `link_failed` /
   * `reauthentication_failed`).
   */
  failed(login: NativeLogin, error?: string) {
    return nativeRedirect(login.redirectUri, {
      error:
        error ??
        (!login.account
          ? 'sign_in_failed'
          : login.account.purpose === 'link'
            ? 'link_failed'
            : 'reauthentication_failed'),
    });
  }

  /**
   * A ticket for a signed-in app to link `provider` or step up through it:
   * token clients only (a browser
   * has `?link=true` and `?reauthenticate=true`), a token session with its
   * `sid`, and an allow-listed `redirectUri`. The URL its system browser
   * opens: the login route with the ticket, which starts the provider's
   * login there (its transaction cookie is the browser's).
   */
  async ticket(
    user: UserPrincipal,
    session: unknown,
    provider: string,
    body: {
      purpose: NativeAccountFlow['purpose'];
      redirectUri: string;
      codeChallenge: string;
    },
  ) {
    const sid = tokenSessionOf(session);
    if (!sid) {
      throw new BadRequestException({
        code: 'token_session_required',
        message:
          'For an app signed in with tokens: a browser links and steps up with `?link=true` and `?reauthenticate=true`.',
      });
    }
    const login = this.nativeLogin(body)!;
    const ticket = await this.handoffs.issueTicket({
      ...login,
      account: {
        purpose: body.purpose,
        userId: user.id,
        sid,
        provider,
        startedAt: Date.now(),
        tenantId: user.tenantId ?? null,
      },
    });
    const url = new URL(
      `/v1/auth/oidc/${encodeURIComponent(provider)}/login`,
      this.http.appUrl,
    );
    url.searchParams.set('ticket', ticket);
    return { url: url.toString() };
  }

  /**
   * The login route opened with a ticket: spent, and the provider's login
   * started in this browser, remembered as the ticket's link or step-up.
   * Both ask the provider to authenticate the user again: a link ticket
   * sent to someone else must not connect their identity in one silent
   * click (their provider session), whoever then catches the redirect. 400
   * for a ticket unknown, used, expired or of another provider.
   */
  async startTicket(provider: string, ticket: string) {
    const login = await this.handoffs.takeTicket(ticket);
    if (!login || login.account.provider !== provider) {
      throw new BadRequestException({
        code: 'invalid_ticket',
        message: 'This ticket is unknown, used or expired: ask for another.',
      });
    }
    const redirect = await this.oidc.start(provider, {});
    const url = reauthenticationUrl(redirect.url);
    // From now: the provider's `auth_time` must not be older than the login.
    await this.remember(url.searchParams.get('state')!, {
      ...login,
      account: { ...login.account, startedAt: Date.now() },
    });
    return { ...redirect, url: url.toString() };
  }

  /**
   * The code of a ticket's callback, with its verifier, for the signed-in
   * app that asked for the ticket: the same user and token session, else
   * 401 (the code is spent either way). A link answers its provider; a
   * step-up new tokens with `auth_time` now (the provider's, when it told),
   * in the same tenant and device, with two-factor as for the exchange
   * (without a code, 401 `mfa_required` and the code still works); the
   * family of the `refreshToken` sent, if any, is revoked.
   */
  async complete(
    user: UserPrincipal,
    session: unknown,
    input: {
      code: string;
      codeVerifier: string;
      refreshToken?: string;
      secondFactor: { code?: string; recoveryCode?: string };
    },
    ip?: string,
  ) {
    const taken = await this.handoffs.takeCode(input.code);
    const sid = tokenSessionOf(session);
    if (
      !taken?.handoff.account ||
      !verifiesChallenge(input.codeVerifier, taken.handoff.codeChallenge) ||
      taken.handoff.userId !== user.id ||
      !sid ||
      taken.handoff.account.sid !== sid
    ) {
      throw new UnauthorizedException(t('account.invalidCode'));
    }
    const { handoff } = taken;
    const { account } = handoff;
    if (account!.purpose === 'link') {
      // Only now, by the app that holds the verifier and the session.
      if (account!.identity) {
        await this.oidcAccounts.linkNative(user.id, account!.identity);
      }
      return { purpose: 'link' as const, provider: account!.provider };
    }
    try {
      const tokens = await this.tokens.issue(user.id, {
        method: handoff.method,
        claims: tokenClaims(
          [],
          handoff.authenticatedAt
            ? new Date(handoff.authenticatedAt)
            : new Date(),
          account!.tenantId,
          { method: handoff.method, device: deviceOfClaims(session) },
        ),
        secondFactor: input.secondFactor,
      });
      // The old family keeps its old time: it goes with the new one issued.
      if (input.refreshToken) {
        await this.tokens.revoke(input.refreshToken);
      }
      await this.audited(
        { userId: user.id, provider: account!.provider },
        'auth.reauthenticated',
        {},
        ip,
      );
      return { purpose: 'reauthenticate' as const, ...tokens };
    } catch (error) {
      if (error instanceof AuthenticationError) {
        if (!input.secondFactor.code && !input.secondFactor.recoveryCode) {
          // Only asked for: the code stays for the retry.
          if (error.code === 'mfa_required') {
            await this.handoffs.restoreCode(input.code, handoff, taken.ttlMs);
          }
        } else {
          // A wrong second factor, as the browser's step-up records it.
          await this.audited(
            { userId: user.id, provider: account!.provider },
            'auth.reauthentication-failed',
            { reason: 'code' },
            ip,
          );
        }
      }
      throw error;
    }
  }

  /**
   * A magic link opened by the app (the browser binding is the app's: it
   * kept the cookie of its request): spent, with no session (the one
   * `consume()` made is discarded: `cookie` clears it), for a code bound
   * to `codeChallenge`. 401 for a link unknown, used, expired or
   * requested elsewhere.
   */
  async handOffMagicLink(token: string, codeChallenge: string) {
    const consumed = await this.signInContext.run('magic-link', () =>
      this.magicLinks.consume(token),
    );
    if (!consumed) {
      throw new UnauthorizedException(t('account.invalidLink'));
    }
    await this.sessions.discard(consumed.session.id);
    const code = await this.handoffs.issueCode({
      userId: consumed.session.userId,
      method: 'magic-link',
      codeChallenge,
    });
    return { code, cookie: this.sessions.clearCookie() };
  }

  /**
   * The tokens for a handoff code and its PKCE verifier (RFC 7636): 401
   * for a code unknown, used, expired or of another verifier (it is spent
   * either way). With two-factor on, a code from the app too: without
   * one, 401 `mfa_required` and the code stays for the retry (its time
   * left); a wrong one spends it. The tenant: `tenantId` (a member, else
   * the token sign-in's 401), else the last chosen.
   */
  async exchange(
    input: {
      code: string;
      codeVerifier: string;
      tenantId?: string;
      secondFactor: { code?: string; recoveryCode?: string };
    },
    context: { ip: string; userAgent: string | undefined },
  ) {
    const taken = await this.handoffs.takeCode(input.code);
    if (
      !taken ||
      // A link's or a step-up's code completes its session only, never signs in.
      taken.handoff.account ||
      !verifiesChallenge(input.codeVerifier, taken.handoff.codeChallenge)
    ) {
      throw new UnauthorizedException(t('account.invalidCode'));
    }
    const { handoff } = taken;
    const user = await this.users.findActive(handoff.userId);
    if (!user) {
      throw new UnauthorizedException(t('account.invalidCode'));
    }
    const tenant = await this.tenantOf(user, handoff, input.tenantId, context);
    try {
      const tokens = await this.tokens.issue(user.id, {
        method: handoff.method,
        claims: tokenClaims(
          [],
          handoff.authenticatedAt
            ? new Date(handoff.authenticatedAt)
            : new Date(),
          tenant,
          { method: handoff.method, device: deviceLabel(context.userAgent) },
        ),
        secondFactor: input.secondFactor,
      });
      await this.events.emitAsync(AUTH_EVENTS.signedIn, {
        user,
        method: handoff.method,
        ip: context.ip,
        userAgent: context.userAgent,
        tenantId: tenant,
      } satisfies SignedInEvent);
      return tokens;
    } catch (error) {
      if (
        error instanceof AuthenticationError &&
        error.code === 'mfa_required' &&
        !input.secondFactor.code &&
        !input.secondFactor.recoveryCode
      ) {
        await this.handoffs.restoreCode(input.code, handoff, taken.ttlMs);
      }
      throw error;
    }
  }

  private async tenantOf(
    user: UserPrincipal,
    handoff: NativeHandoff,
    tenantId: string | undefined,
    context: { ip: string },
  ) {
    if (tenantId === undefined) {
      return this.users.defaultTenant(user.id);
    }
    if (!(await this.users.isMember(user.id, tenantId))) {
      await this.events.emitAsync(AUTH_EVENTS.signInFailed, {
        email: user.email,
        user,
        method: handoff.method,
        ip: context.ip,
      } satisfies SignInFailedEvent);
      throw new UnauthorizedException(t('auth.invalidCredentials'));
    }
    return tenantId;
  }
}

/** The `sid` of a token client's session (its access token's claims), if it is one. */
function tokenSessionOf(session: unknown) {
  if (authenticationOf(session)?.via !== 'token') {
    return undefined;
  }
  const sid = (session as { sid?: unknown }).sid;
  return typeof sid === 'string' && sid ? sid : undefined;
}

/** The `dev` claim of a token client's claims (tokenClaims()), if any. */
function deviceOfClaims(session: unknown) {
  const device = (session as { dev?: unknown } | undefined)?.dev;
  return typeof device === 'string' ? device : undefined;
}
