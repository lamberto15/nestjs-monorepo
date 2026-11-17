import {
  github,
  google,
  microsoft,
  type OidcProviderConfig,
} from '@nestjs/authentication';
import type { AccountConfig } from './account.config.js';

/** The OAuth / OpenID Connect providers whose credentials are set, by name. */
export function oidcProviders({
  providers,
}: Pick<AccountConfig, 'providers'>): Record<string, OidcProviderConfig> {
  return {
    ...(providers.google && { google: google(providers.google) }),
    ...(providers.microsoft && { microsoft: microsoft(providers.microsoft) }),
    ...(providers.github && { github: github(providers.github) }),
  };
}
