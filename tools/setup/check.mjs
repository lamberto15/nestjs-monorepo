// Checks an env file against its template (apps/api/env.example): the
// variables it marks "Required." must be set; a variable the template does
// not name is a typo or a removed one; one set twice is ambiguous. The exit
// code is 1 only for a REQUIRED variable that is unset (the app would not
// start). Reached by `pnpm run setup --check` and at the end of setup.
import { existsSync, readFileSync } from 'node:fs';
import { compare } from './envfile.mjs';

/** Prints the findings for `filePath`; returns the exit code. */
export function check(templateText, filePath, io) {
  if (!existsSync(filePath)) {
    io.err(`${filePath} does not exist: pnpm run setup writes it.`);
    return 1;
  }
  const found = compare(templateText, readFileSync(filePath, 'utf8'));
  if (!found.empty.length && !found.unknown.length && !found.repeated.length) {
    io.out('ok: every REQUIRED variable is set.');
    return 0;
  }
  for (const key of found.empty) io.out(`REQUIRED and unset: ${key}`);
  for (const key of found.unknown) {
    io.out(`not in env.example (a typo, or a removed variable): ${key}`);
  }
  for (const key of found.repeated) io.out(`set more than once: ${key}`);
  return found.empty.length ? 1 : 0;
}
