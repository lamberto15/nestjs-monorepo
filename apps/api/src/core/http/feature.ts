import { Inject, Injectable, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryService } from '@nestjs/core';
import { z } from 'zod';

/** What a deployment switch tells a client: on or off, a mode, a list. */
export type FeatureValue = boolean | string | string[];

/** A provider that tells one switch's value (`@Feature()`). */
export interface FeatureSwitch {
  value(): FeatureValue;
}

/**
 * Marks a provider as one switch of `GET /v1/features`, by name with the
 * schema of its value (one key): the module that owns the capability tells
 * whether it is on, the way it reads it itself, so the answer can't disagree
 * with its routes. FeaturesService finds every one, and the OpenAPI
 * document has each as a key: no list names them.
 *
 * ```ts
 * @Feature({ passkeys: z.boolean().describe('Passkeys (`/v1/auth/passkeys`).') })
 * @Injectable()
 * export class PasskeysFeature implements FeatureSwitch {
 *   constructor(@Inject(accountConfig.KEY) private readonly config: AccountSettings) {}
 *   value() { return this.config.passkeys; }
 * }
 * ```
 */
export const Feature =
  DiscoveryService.createDecorator<Record<string, z.ZodType<FeatureValue>>>();

/**
 * The on/off switch `name`: with `path`, the variable a route checks with
 * `@RequiresSwitch(path, …)`, read the same way (anything but `true` is
 * off), so the two can't disagree; without, a module that is on whenever it
 * is in the app. `providers: [switchFeature('mfa', '…', 'account.mfa')]`.
 */
export function switchFeature(
  name: string,
  description: string,
  path?: string,
): Type<FeatureSwitch> {
  @Feature({ [name]: z.boolean().describe(description) })
  @Injectable()
  class SwitchFeature implements FeatureSwitch {
    constructor(
      @Inject(ConfigService) private readonly config: ConfigService,
    ) {}

    value() {
      return path === undefined || this.config.get<unknown>(path) === true;
    }
  }
  return SwitchFeature;
}
