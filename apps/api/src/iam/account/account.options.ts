import { Injectable } from '@nestjs/common';
import type { AuthenticationModuleOptions } from '@nestjs/authentication';
import { httpConfig } from '../../core/http/http.config.js';
import { authConfig } from '../auth/auth.config.js';
import { AuthenticationOptionsPart } from '../auth/authentication-options.js';
import { accountConfig } from './account.config.js';
import { oidcProviders } from './oidc.providers.js';

/**
 * This module's options of @nestjs/authentication: two-factor, magic
 * links, providers, reset and verification links. Each goes with its
 * handler (account.handlers.ts), registered under the same condition:
 * magic links only with AUTH_MAGIC_LINK=on, providers only when one is
 * configured. Links open pages of the web app (WEB_URL, else APP_URL).
 *
 * `mfa.encryption` is off: AccountStores encrypts the TOTP secrets with
 * the deployment's data keys (core/encryption), which rotate with the rest.
 */
@AuthenticationOptionsPart(() => accountOptions())
@Injectable()
export class AccountOptions {}

export function accountOptions(): Partial<AuthenticationModuleOptions> {
  const config = accountConfig();
  const http = httpConfig();
  const web = (config.webUrl ?? http.appUrl).replace(/\/+$/, '');
  const providers = oidcProviders(config);
  // Without Secure (tests only), the cookies lose their `__Host-` prefix, as the session's.
  const cookie = { secure: authConfig().sessionCookieSecure };
  return {
    mfa: { encryption: false, issuer: config.mfaIssuer },
    passwordReset: { url: `${web}/reset-password` },
    emailVerification: { url: `${web}/verify-email` },
    ...(config.magicLink && {
      magicLink: { url: `${web}/magic-link`, cookie },
    }),
    ...(Object.keys(providers).length > 0 && {
      oidc: {
        providers,
        callbackUrl: `${http.appUrl.replace(/\/+$/, '')}/v1/auth/oidc/:provider/callback`,
        redirectAfterLogin: `${web}/`,
        cookie,
      },
    }),
  };
}
