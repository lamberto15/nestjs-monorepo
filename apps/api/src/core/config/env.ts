import type { z } from 'zod';
import {
  readSecretFiles,
  secretNames,
  secretVariables,
} from './secret-files.js';

/**
 * A module's environment variables, checked against the schema in its
 * `*.config.ts` (a `registerAs()` namespace). @nestjs/config validates one
 * schema for the whole app (`validationSchema`); this is the same check for
 * one namespace, so a module's variables are declared in its own folder and
 * leave with it. A variable marked with `secret()` can also come from
 * `X_FILE` (secret-files.ts). A wrong value stops the start, naming every
 * variable at fault and never its value.
 */
export function readEnv<Schema extends z.ZodType>(
  schema: Schema,
  env: Record<string, string | undefined> = process.env,
): z.output<Schema> {
  const secrets = secretNames(schema);
  for (const name of secrets) {
    secretVariables.add(name);
  }
  const { values, problems } = readSecretFiles(env, secrets);
  const result = schema.safeParse({ ...env, ...values });
  if (result.success && problems.length === 0) {
    return result.data;
  }
  const messages = [
    ...problems.map(({ variable, message }) => `${variable}: ${message}`),
    ...(result.error?.issues ?? []).map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    ),
  ];
  throw new Error(`Invalid environment:\n${messages.join('\n')}`);
}
