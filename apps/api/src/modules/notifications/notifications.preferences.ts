import { z } from 'zod';
import type { NotificationTypeDeclaration } from './notifications.types.js';

/**
 * How a recipient's preferences combine with the types' defaults: pure
 * functions, read and tested apart from the services.
 */

/**
 * The channels a recipient may set, with what each setting holds and the
 * value that means off. In-app and realtime are always on and not here.
 */
export const CHANNELS = {
  email: {
    schema: z.union([
      z.enum(['immediate', 'hourly', 'daily']),
      z.literal(false),
    ]),
    off: false as const,
  },
  push: { schema: z.boolean(), off: false as const },
} as const;
export type ChannelName = keyof typeof CHANNELS;

export const emailSettingSchema = CHANNELS.email.schema;
export const pushSettingSchema = CHANNELS.push.schema;

/** The channels of a type the recipient is offered: those they may set, less its `fixed` ones. */
export const offered = (
  declaration: NotificationTypeDeclaration<any>,
  settable: readonly ChannelName[],
): ChannelName[] =>
  settable.filter((name) => !declaration.fixed?.includes(name));

/** Settings are small values (a boolean, a mode): equal when their JSON is. */
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A type's default for a channel: what it declares, else off. */
export const defaultOf = (
  declaration: NotificationTypeDeclaration<any>,
  channel: ChannelName,
): unknown => declaration[channel] ?? CHANNELS[channel].off;

/**
 * The effective setting of each channel the recipient may set, for one type:
 * their override when it is valid, else the type's default. A mandatory type
 * keeps its default where an override would switch the channel off (the
 * preferences API refuses such an override; this guards stored ones against a
 * type that became mandatory since).
 */
export function effectiveSettings(
  declaration: NotificationTypeDeclaration<any>,
  overrides: Record<string, unknown> | undefined,
  settable: readonly ChannelName[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const name of settable) {
    const { schema, off } = CHANNELS[name];
    const fallback = defaultOf(declaration, name);
    const override = overrides?.[name];
    const parsed =
      override === undefined ? undefined : schema.safeParse(override);
    // A fixed channel keeps its default, whatever was stored.
    let value: unknown =
      parsed?.success && !declaration.fixed?.includes(name)
        ? parsed.data
        : fallback;
    if (declaration.mandatory && same(value, off) && !same(fallback, off)) {
      value = fallback;
    }
    result[name] = value;
  }
  return result;
}

/**
 * The schema of `PUT /notifications/preferences` for a recipient who may set
 * these channels: the declared types, each with those channels (another
 * channel is refused by name); a mandatory type refuses the value that means
 * off on a channel its default has on (one off by default may stay off, as
 * `effectiveSettings()` reports it: what GET answers, PUT takes). Errors
 * name `<type>.<channel>`.
 */
export function preferencesSchema(
  declarations: readonly NotificationTypeDeclaration<any>[],
  settable: readonly ChannelName[],
) {
  const perType = (declaration: NotificationTypeDeclaration<any>) => {
    const own = offered(declaration, settable);
    return z
      .looseObject(
        Object.fromEntries(
          own.map((name) => [name, CHANNELS[name].schema.optional()]),
        ),
      )
      .superRefine((value, ctx) => {
        for (const name of Object.keys(value)) {
          if (!(own as readonly string[]).includes(name)) {
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message: 'Not a channel you can set.',
            });
          }
        }
        if (!declaration.mandatory) return;
        for (const name of settable) {
          const given = value[name];
          if (
            given !== undefined &&
            same(given, CHANNELS[name].off) &&
            !same(defaultOf(declaration, name), CHANNELS[name].off)
          ) {
            ctx.addIssue({
              code: 'custom',
              path: [name],
              message: 'This notification cannot be switched off.',
            });
          }
        }
      });
  };
  const types = new Set(declarations.map((declaration) => declaration.type));
  return z
    .looseObject(
      Object.fromEntries(
        declarations.map((declaration) => [
          declaration.type,
          perType(declaration).optional(),
        ]),
      ),
    )
    .superRefine((value, ctx) => {
      for (const type of Object.keys(value)) {
        if (!types.has(type)) {
          ctx.addIssue({
            code: 'custom',
            path: [type],
            message: 'Unknown notification type.',
          });
        }
      }
    });
}
