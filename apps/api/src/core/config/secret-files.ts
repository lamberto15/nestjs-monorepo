import { readFileSync } from 'node:fs';
import type { z } from 'zod';

/**
 * Secrets from files: a variable marked with `secret()` (env.helpers.ts) can
 * be given as `X_FILE`, the path of a file holding its value (a Docker or
 * Kubernetes secret at /run/secrets/…). Both `X` and `X_FILE` is an error, so
 * a stale value never wins silently. Custom code: @nestjs/config reads
 * variables and .env files only. A relative path is the process's.
 */

const isSet = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Every secret variable a config has read so far: the logger masks them
 * (core/logging), so `secret()` is the only mark a variable needs.
 */
export const secretVariables = new Set<string>();

/** The names of a schema's secret variables. */
export function secretNames(schema: z.ZodType) {
  const shape = (schema as Partial<z.ZodObject>).shape ?? {};
  return Object.entries(shape)
    .filter(([, variable]) => variable.meta()?.secret === true)
    .map(([name]) => name);
}

/** A file's contents without its line breaks at the end (`echo`, CRLF). */
function withoutTrailingLineBreaks(contents: string) {
  // A loop, not /(?:\r?\n)+$/, which is quadratic on many line breaks.
  let end = contents.length;
  while (contents.charAt(end - 1) === '\n') {
    end -= contents.charAt(end - 2) === '\r' ? 2 : 1;
  }
  return contents.slice(0, end);
}

/**
 * The values of the secrets whose `X_FILE` is set, and what went wrong with
 * the others (a problem per `X_FILE`: both set, unreadable, empty). A problem
 * never carries a value: the path and the error code only.
 */
export function readSecretFiles(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
) {
  const values: Record<string, string> = {};
  const problems: { variable: string; message: string }[] = [];
  for (const name of names) {
    const variable = `${name}_FILE`;
    const path = env[variable]?.trim();
    if (!path) {
      continue;
    }
    if (isSet(env[name])) {
      problems.push({
        variable,
        message: `${name} and ${variable} are both set: keep one`,
      });
      continue;
    }
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'unreadable';
      problems.push({ variable, message: `can't read ${path} (${code})` });
      continue;
    }
    const value = withoutTrailingLineBreaks(contents);
    if (value.trim() === '') {
      problems.push({ variable, message: `${path} is empty` });
      continue;
    }
    values[name] = value;
  }
  return { values, problems };
}
