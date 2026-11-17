import type { z } from 'zod';

/**
 * A module's environment variables, checked against the schema in its
 * `*.config.ts` (a `registerAs()` namespace). @nestjs/config validates one
 * schema for the whole app (`validationSchema`); this is the same check for
 * one namespace, so a module's variables are declared in its own folder and
 * leave with it. A wrong value stops the start, naming every variable at
 * fault and never its value.
 */
export function readEnv<Schema extends z.ZodType>(
  schema: Schema,
  env: Record<string, string | undefined> = process.env,
): z.output<Schema> {
  const result = schema.safeParse(env);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map(
    (issue) => `${issue.path.join('.')}: ${issue.message}`,
  );
  throw new Error(`Invalid environment:\n${problems.join('\n')}`);
}
