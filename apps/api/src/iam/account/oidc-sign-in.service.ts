import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { OidcService } from '@nestjs/authentication';
import type { ConfigType } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { webAppUrl } from '../../core/http/redirect-path.js';
import { authConfig } from '../auth/auth.config.js';
import { authenticationOf, isRecent } from '../auth/authentication-method.js';
import type { UserPrincipal } from '../auth/principal.js';
import { accountConfig } from './account.config.js';
import { notWhileImpersonating, verifiedEmailOnly } from './account.schemas.js';
import { NativeSignIn } from './native-sign-in.service.js';
import { ReauthenticationRefused } from './oidc-reauthentication.js';
import { oidcProviders } from './oidc.providers.js';
import {
  type CallbackRequest,
  ProviderSignIn,
} from './provider-sign-in.service.js';

/** What GET /auth/oidc/:provider/login reads of its query. */
export interface LoginQuery {
  redirectTo?: string;
  link?: string;
  reauthenticate?: string;
  redirectUri?: string;
  codeChallenge?: string;
  ticket?: string;
}

/**
 * The flows of OidcController's routes: which sign-in a login starts (a
 * browser's, a native app's, a link, a step-up, a signed-in app's ticket),
 * what a callback finishes, and where the browser lands. The controller
 * keeps the cookies: this answers the redirect and what to set or clear.
 */
@Injectable()
export class OidcSignIn {
  constructor(
    private readonly oidc: OidcService,
    private readonly providers: ProviderSignIn,
    private readonly native: NativeSignIn,
    @Inject(accountConfig.KEY)
    private readonly config: ConfigType<typeof accountConfig>,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  /**
   * Where a login sends the browser; `stepUpState`: a step-up started,
   * whose state the browser's step-up cookie keeps.
   */
  async login(
    user: UserPrincipal | null,
    session: unknown,
    provider: string,
    {
      redirectTo,
      link,
      reauthenticate,
      redirectUri,
      codeChallenge,
      ticket,
    }: LoginQuery,
  ): Promise<{ redirect: { url: string }; stepUpState?: string }> {
    if (ticket !== undefined) {
      // A signed-in app's link or step-up: the ticket says whose, and how.
      this.configured(provider);
      return { redirect: await this.native.startTicket(provider, ticket) };
    }
    const native = this.native.nativeLogin({ redirectUri, codeChallenge });
    if (native) {
      // A native app's sign-in (no session here: its code, then tokens).
      if (link === 'true' || reauthenticate === 'true') {
        throw new BadRequestException(
          'A native sign-in neither links nor re-authenticates.',
        );
      }
      this.configured(provider);
      const redirect = await this.oidc.start(provider, {});
      await this.native.remember(stateOf(redirect.url), native);
      return { redirect };
    }
    if (reauthenticate === 'true') {
      if (link === 'true') {
        throw new BadRequestException(
          '`link` and `reauthenticate` are two flows: one at a time.',
        );
      }
      if (!user) {
        throw new UnauthorizedException();
      }
      notWhileImpersonating(user);
      // As linking: an address the person proved (an invitation, the link).
      verifiedEmailOnly(user);
      this.configured(provider);
      const redirect = await this.providers.startReauthentication(
        user,
        provider,
        redirectTo,
      );
      // This browser started a step-up for this state: its callback is one.
      return { redirect, stepUpState: stateOf(redirect.url) };
    }
    if (link === 'true') {
      if (!user) {
        throw new UnauthorizedException();
      }
      notWhileImpersonating(user);
      verifiedEmailOnly(user);
      if (!this.isRecent(session)) {
        return {
          redirect: {
            url: this.backToWebApp(redirectTo, 'reauthentication_required'),
          },
        };
      }
    }
    this.configured(provider);
    return {
      redirect: await this.oidc.start(provider, {
        redirectTo,
        link: link === 'true',
      }),
    };
  }

  /**
   * The provider's callback: where the browser lands, the cookies to set,
   * and whether the step-up cookie is spent. `stepUpState`: the state the
   * browser's step-up cookie names.
   */
  async callback(
    provider: string,
    query: Record<string, string | undefined>,
    request: CallbackRequest,
    stepUpState: string | undefined,
  ): Promise<{
    redirect: { url: string };
    cookies: string[];
    clearStepUp: boolean;
  }> {
    this.configured(provider);
    const native = await this.native.login(query.state);
    if (native) {
      try {
        const { url, cookies } = await this.native.finishProvider(
          provider,
          query,
          native,
          request.ip,
        );
        return { redirect: { url }, cookies, clearStepUp: false };
      } catch (error) {
        // The app's browser lands back in the app, never on a problem page.
        if (
          error instanceof HttpException ||
          error instanceof ReauthenticationRefused
        ) {
          return {
            redirect: { url: this.native.failed(native) },
            cookies: [],
            clearStepUp: false,
          };
        }
        throw error;
      }
    }
    const stepUpExpected =
      query.state !== undefined && stepUpState === query.state;
    try {
      const redirect = await this.providers.signIn(provider, query, request, {
        stepUpExpected,
      });
      // The login's `redirectTo` (a path, else the package's
      // `redirectAfterLogin`) checked again and made the web app's: a login
      // stored before the rule lands on its root, and a path lands on the
      // web app, not on this API's origin.
      return {
        redirect: { ...redirect, url: this.webApp(redirect.url).toString() },
        cookies: [],
        clearStepUp: stepUpExpected,
      };
    } catch (error) {
      if (error instanceof ReauthenticationRefused) {
        return {
          redirect: {
            url: this.backToWebApp(error.redirectTo, 'reauthentication_failed'),
          },
          cookies: [],
          clearStepUp: true,
        };
      }
      throw error;
    }
  }

  /** A signed-in app's ticket to link `provider` or step up through it. */
  nativeTicket(
    user: UserPrincipal,
    session: unknown,
    provider: string,
    body: Parameters<NativeSignIn['ticket']>[3],
  ) {
    notWhileImpersonating(user);
    // As the browser's: an address the person proved.
    verifiedEmailOnly(user);
    this.configured(provider);
    return this.native.ticket(user, session, provider, body);
  }

  /** A native link or step-up finished: a link answers the identity it made. */
  async nativeComplete(
    user: UserPrincipal,
    session: unknown,
    input: Parameters<NativeSignIn['complete']>[2],
    ip: string,
  ) {
    const done = await this.native.complete(user, session, input, ip);
    if (done.purpose === 'reauthenticate') {
      return done;
    }
    const identity = (await this.providers.identities(user.id)).find(
      (item) => item.provider === done.provider,
    );
    return { purpose: done.purpose, identity };
  }

  async unlink(user: UserPrincipal, provider: string) {
    notWhileImpersonating(user);
    await this.providers.unlink(user, provider);
  }

  /** 404 for a provider without credentials (and when none is configured at all). */
  private configured(provider: string) {
    if (!Object.hasOwn(oidcProviders(this.config), provider)) {
      throw new NotFoundException(`No provider named "${provider}".`);
    }
  }

  /**
   * `redirectTo` (a path of the web app, else its root: `webAppUrl`, the
   * one rule for every redirect target) with `?error=`.
   */
  private backToWebApp(redirectTo: string | undefined, error: string) {
    const url = this.webApp(redirectTo);
    url.searchParams.set('error', error);
    return url.toString();
  }

  /** `value` on the web app (WEB_URL, else APP_URL), else its root. */
  private webApp(value: unknown) {
    return webAppUrl(value, this.http.webUrl);
  }

  /** Whether the session's sign-in is within REAUTHENTICATION_MAX_AGE_MINUTES. */
  private isRecent(session: unknown) {
    const authentication = authenticationOf(session);
    const at = authentication?.authenticatedAt;
    return isRecent(
      authentication,
      at
        ? new Date(
            at.getTime() + this.auth.reauthenticationMaxAgeMinutes * 60_000,
          )
        : null,
    );
  }
}

const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
