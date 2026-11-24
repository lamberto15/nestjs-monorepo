import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { httpConfig } from '../../core/http/http.config.js';
import { webAppUrl } from '../../core/http/redirect-path.js';
import { Oauth2Sso } from './oauth2-sso.service.js';
import { OidcSso } from './oidc-sso.service.js';
import { SamlSso } from './saml-sso.service.js';
import { SsoAccounts } from './sso-accounts.service.js';
import type { SsoConnection } from './sso-connections.service.js';
import { SsoRefused } from './sso-refused.js';

interface Client {
  ip: string;
  userAgent: string | undefined;
}

/**
 * The sign-in flows through a tenant's connection, as SsoAuthController
 * drives them: each answers where the browser goes next, and the binding
 * its cookie keeps (sso-browser.ts); the controller sets the cookies. Every
 * refusal lands on the web app's root with `?error=` and, after the IdP
 * answered, an audit entry (SsoAccounts.refused).
 */
@Injectable()
export class SsoSignIn {
  constructor(
    private readonly oidc: OidcSso,
    private readonly oauth2: Oauth2Sso,
    private readonly saml: SamlSso,
    private readonly accounts: SsoAccounts,
    @Inject(httpConfig.KEY)
    private readonly http: ConfigType<typeof httpConfig>,
  ) {}

  /** Where to send the browser to sign in, and the binding of this browser; `?error=sso_unavailable` when refused. */
  async start(
    connection: SsoConnection,
    redirectTo: string | undefined,
  ): Promise<{ url: string; binding?: string }> {
    try {
      return connection.protocol === 'oidc'
        ? await this.oidc.start(connection, redirectTo)
        : connection.protocol === 'oauth2'
          ? await this.oauth2.start(connection, redirectTo)
          : await this.saml.start(connection, redirectTo);
    } catch (error) {
      if (error instanceof SsoRefused) {
        return { url: this.backToWebApp('sso_unavailable') };
      }
      throw error;
    }
  }

  /** The authorization code flow's return (OpenID Connect or OAuth 2.0). */
  async finishCode(
    protocol: 'oidc' | 'oauth2',
    connection: SsoConnection,
    query: Record<string, string | undefined>,
    binding: string | undefined,
    client: Client,
  ) {
    let label = 'sso';
    try {
      const { identity, redirectTo } = await (
        protocol === 'oidc' ? this.oidc : this.oauth2
      ).finish(
        connection,
        Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ) as Record<string, string>,
        binding,
      );
      label = identity.email ?? identity.subject;
      const userId = await this.accounts.resolve(connection, identity);
      await this.accounts.signIn(connection, userId, {
        ...client,
        authenticatedAt: identity.authenticatedAt,
      });
      return this.webApp(redirectTo).toString();
    } catch (error) {
      if (error instanceof SsoRefused) {
        await this.accounts.refused(connection, label, error.reason, client.ip);
        return this.backToWebApp('sso_failed');
      }
      throw error;
    }
  }

  /**
   * The SAML response, checked and handed over to `complete` (`url`) with
   * the hand-off's binding; refused: `failed`, the web app with `?error=`.
   */
  async consumeSaml(
    connection: SsoConnection,
    samlResponse: string,
    loginBinding: string | undefined,
    ip: string,
    // As the URL said them: the hand-over continues on the same path.
    params: { tenantId: string; connectionId: string },
  ): Promise<{ url: string; binding?: string; failed?: true }> {
    let label = 'sso';
    try {
      const { identity, requestId, redirectTo } = await this.saml.consume(
        connection,
        samlResponse,
        loginBinding,
      );
      label = identity.email ?? identity.subject;
      const userId = await this.accounts.resolve(connection, identity);
      const { binding } = await this.saml.handOver(
        connection,
        userId,
        identity.authenticatedAt,
        requestId,
        redirectTo,
      );
      return { url: this.urlOf(params, 'saml/complete'), binding };
    } catch (error) {
      if (error instanceof SsoRefused) {
        await this.accounts.refused(connection, label, error.reason, ip);
        return { url: this.backToWebApp('sso_failed'), failed: true };
      }
      throw error;
    }
  }

  /** Signs in the hand-over this browser's binding names. */
  async completeSaml(
    connection: SsoConnection,
    binding: string | undefined,
    client: Client,
  ) {
    try {
      const handed = await this.saml.takeHandOver(connection, binding);
      await this.accounts.signIn(connection, handed.userId, {
        ...client,
        authenticatedAt: handed.authenticatedAt,
      });
      return this.webApp(handed.redirectTo).toString();
    } catch (error) {
      if (error instanceof SsoRefused) {
        await this.accounts.refused(connection, 'sso', error.reason, client.ip);
        return this.backToWebApp('sso_failed');
      }
      throw error;
    }
  }

  /** The connection's SAML metadata; 404 for another protocol. */
  samlMetadata(connection: SsoConnection) {
    if (connection.protocol !== 'saml') {
      throw new NotFoundException('Not a SAML connection.');
    }
    return this.saml.metadata(connection);
  }

  /** A sibling route of this connection, on this API. */
  private urlOf(
    { tenantId, connectionId }: { tenantId: string; connectionId: string },
    path: string,
  ) {
    return `${this.http.appUrl}/v1/auth/sso/${tenantId}/${connectionId}/${path}`;
  }

  /** `value` on the web app (a stored path checked again), else its root. */
  private webApp(value: unknown) {
    return webAppUrl(value, this.http.webUrl);
  }

  private backToWebApp(error: string) {
    const url = this.webApp(undefined);
    url.searchParams.set('error', error);
    return url.toString();
  }
}
