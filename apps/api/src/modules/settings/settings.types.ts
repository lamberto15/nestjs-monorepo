import { z } from 'zod';
import type { FlagRule } from './settings.rules.js';

/**
 * Where a setting's value may be set: for the whole tenant, for an
 * organizational unit's current members (not those of units below it), or
 * per principal. Every value is a tenant's (rows under row-level security);
 * what holds for every tenant is the declaration's default, in code, or the
 * value the deployment's operators set (the platform value).
 */
export const SETTING_SCOPES = ['tenant', 'unit', 'user'] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

/**
 * A setting a module declares in its own folder and registers in its own
 * imports with `SettingsModule.forFeature(DECLARATIONS)`: a typed value
 * with a default, that administrators change at runtime, for their tenant
 * or a unit, and that users may set for themselves when `user` is among its
 * scopes (a preference).
 *
 * ```ts
 * export const NOTE_PUBLISH_DELAY = setting({ key: 'notes.publishDelay', label: 'Publication delay', schema: duration, default: '10s' });
 * export const NOTE_SETTINGS = defineSettings([NOTE_PUBLISH_DELAY, NOTE_RICH_TEXT]);
 * // in a service
 * const delay = await this.settings.get(NOTE_PUBLISH_DELAY);
 * ```
 */
export interface SettingDeclaration<T = unknown> {
  /** Dotted, the module first: `notes.publishDelay`. */
  key: string;
  label: string;
  description?: string;
  schema: z.ZodType<T>;
  default: T;
  /** Where it may be overridden; default `['tenant']`; `[]`: only the operators' platform value. */
  scopes?: readonly SettingScope[];
  /** Shown to every caller by GET /settings (default), or only to those who may read settings. */
  public?: boolean;
  /** A feature flag: a boolean that can also roll out to a percentage of principals. */
  flag?: boolean;
  /**
   * A string kept encrypted at rest (core/encryption, DATA_ENCRYPTION_KEYS
   * required) and never shown by the API: views say whether one is set
   * (`source`), not its value. Read it with `settings.get()`.
   */
  secret?: boolean;
}

export const setting = <const T>(declaration: SettingDeclaration<T>) =>
  declaration;

/**
 * A feature flag: on or off, with a default, that administrators switch at
 * runtime, for their tenant, a unit or one principal, or roll out to a
 * stable percentage of the tenant's principals, drawn apart in each tenant.
 * Read it with `settings.enabled(FLAG, principal)`, or close a route with
 * `@RequireFlag(FLAG)`.
 */
export const flag = (
  declaration: Omit<SettingDeclaration<boolean>, 'schema' | 'flag'>,
): SettingDeclaration<boolean> => ({
  scopes: ['tenant', 'unit', 'user'],
  ...declaration,
  schema: z.boolean(),
  flag: true,
});

export const defineSettings = <
  const T extends readonly SettingDeclaration<any>[],
>(
  settings: T,
) => settings;

/**
 * A value an operator set for every tenant (`PUT /settings/{key}/platform`):
 * the runtime default, below each tenant's own values, or, `enforced`,
 * above all of them (a kill switch).
 */
export interface PlatformSettingValue {
  /** Null: only `rollout` applies (a flag). */
  value: unknown;
  enforced: boolean;
  /** Flags: the percentage of each tenant's principals it is on for, when no value is set. */
  rollout: number | null;
  /** Flags: targeting rules, before the value and the rollout (settings.rules.ts). */
  rules?: readonly FlagRule[];
}

/** A stored override: one scope's value of a setting (and a flag's rollout and rules at the tenant scope). */
export interface SettingOverride {
  key: string;
  scope: SettingScope;
  /** The unit's id, the principal's key (`user:<id>`), or `''` for the tenant. */
  scopeId: string;
  value: unknown;
  rollout: number | null;
  rules?: readonly FlagRule[];
}
