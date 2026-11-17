import { DiscoveryService } from '@nestjs/core';

/** What a deployment switch tells a client: on or off, a mode, a list. */
export type FeatureValue = boolean | string | string[];

/** A provider that tells one switch's value (`@Feature()`). */
export interface FeatureSwitch {
  value(): FeatureValue;
}

/**
 * Marks a provider as the switch `name` of `GET /v1/features`: the module
 * that owns the capability tells whether it is on, the way it reads it
 * itself, so the answer can't disagree with its routes. FeaturesService finds
 * every one: no list names them.
 *
 * ```ts
 * @Feature('passkeys')
 * @Injectable()
 * export class PasskeysFeature implements FeatureSwitch {
 *   constructor(@Inject(accountConfig.KEY) private readonly config: AccountSettings) {}
 *   value() { return this.config.passkeys; }
 * }
 * ```
 */
export const Feature = DiscoveryService.createDecorator<string>();
