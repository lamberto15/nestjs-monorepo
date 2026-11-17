import { z } from 'zod';

/**
 * Building blocks for the schema in a module's `*.config.ts`. Variables
 * arrive as strings, and `FOO=` in a .env file means "not set", so each
 * helper treats an empty value as unset. Plain Zod works too; these only
 * save the repetition. `.describe()` is the line shown in env.example, and
 * `.meta({ example })` the value shown for a required variable.
 */

const unsetIfEmpty = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** A required string: unset or empty fails. */
export const required = () => z.preprocess(unsetIfEmpty, z.string().trim());

/** An optional string: unset or empty is `undefined`. */
export const optional = () =>
  z.preprocess(unsetIfEmpty, z.string().trim().optional());

/** A string with a default, used when unset or empty. */
export const withDefault = (fallback: string) =>
  z.preprocess(unsetIfEmpty, z.string().trim().default(fallback));

/** An integer with a default, used when unset or empty. */
export const integer = (
  fallback: number,
  { min, max }: { min?: number; max?: number } = {},
) => {
  let number = z.coerce.number().int();
  if (min !== undefined) number = number.min(min);
  if (max !== undefined) number = number.max(max);
  return z.preprocess(unsetIfEmpty, number.default(fallback));
};

/** `on` or `off`, as a boolean. */
export const flag = (fallback: 'on' | 'off') =>
  z
    .preprocess(unsetIfEmpty, z.enum(['on', 'off']).default(fallback))
    .transform((value) => value === 'on');

/** One of a fixed set of words; unset or empty, the fallback. */
export const choice = <const T extends [string, ...string[]]>(
  values: T,
  fallback: T[number],
) => z.preprocess(unsetIfEmpty, z.enum(values).default(fallback));

/** A comma-separated list, as an array (empty when unset). */
export const list = () =>
  z.preprocess(unsetIfEmpty, z.string().optional()).transform((value) =>
    (value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

/** An absolute URL without trailing slashes; optional unless given a fallback. */
export const baseUrl = (fallback?: string) =>
  z
    .preprocess(
      unsetIfEmpty,
      fallback === undefined ? z.url().optional() : z.url().default(fallback),
    )
    .transform((value) => {
      let end = value?.length ?? 0;
      while (value?.charAt(end - 1) === '/') end -= 1;
      return value?.slice(0, end);
    });

/**
 * Marks a variable as a secret (a password, key or token, or a URL with a
 * password in it): `readEnv` also accepts it as `X_FILE`, the path of a
 * file holding the value (a Docker or Kubernetes secret), and env.example
 * says so. Wrap the variable's whole schema: `secret(optional())`.
 */
export const secret = <Schema extends z.ZodType>(schema: Schema) =>
  schema.meta({ secret: true });
