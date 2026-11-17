import type { AuthenticationModuleOptions } from '@nestjs/authentication';
import type { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';

/** What a part of the options is built from: the app's configuration. */
export interface AuthenticationOptionsContext {
  config: ConfigService;
}

/** Builds the options of one feature (`{ mfa: … }`, `{ magicLink: … }`). */
export type AuthenticationOptionsFactory = (
  context: AuthenticationOptionsContext,
) =>
  | Partial<AuthenticationModuleOptions>
  | Promise<Partial<AuthenticationModuleOptions>>;

/**
 * How a module adds its own options to @nestjs/authentication's without
 * editing AuthModule: it marks one of its providers (usually the feature's
 * handler, which registers itself with AuthenticationRegistry) with the
 * part it brings. AuthModule's factory merges every part into the options
 * it builds (session, access tokens), and refuses at startup a key that
 * two of them set.
 *
 * ```ts
 * @Injectable()
 * @AuthenticationOptionsPart(({ config }) => ({
 *   mfa: { issuer: 'Acme', encryption: { keys: config.getOrThrow('mfa.keys') } },
 *   password: { logN: 17 },
 * }))
 * export class MfaFeature {}
 * ```
 */
export const AuthenticationOptionsPart =
  DiscoveryService.createDecorator<AuthenticationOptionsFactory>();

/**
 * `base` with every module's part merged in. Read from the providers'
 * classes (scanned already), so it works inside `forRootAsync()`'s
 * factory, before those providers exist.
 */
export async function withOptionParts(
  base: AuthenticationModuleOptions,
  discovery: DiscoveryService,
  context: AuthenticationOptionsContext,
): Promise<AuthenticationModuleOptions> {
  const merged: Record<string, unknown> = { ...base };
  const wrappers = discovery.getProviders({
    metadataKey: AuthenticationOptionsPart.KEY,
  });
  const factories = new Set(
    wrappers.map((wrapper) =>
      discovery.getMetadataByDecorator(AuthenticationOptionsPart, wrapper),
    ),
  );
  for (const factory of factories) {
    if (typeof factory !== 'function') continue;
    const part = await factory(context);
    for (const [key, value] of Object.entries(part)) {
      if (merged[key] !== undefined) {
        throw new Error(
          `@nestjs/authentication's \`${key}\` option is set twice (AuthModule or another @AuthenticationOptionsPart()): keep one.`,
        );
      }
      merged[key] = value;
    }
  }
  return merged as AuthenticationModuleOptions;
}
