import { randomBytes } from 'node:crypto';
import type { Operator } from './operator.js';

/** A refusal for the person at the terminal: printed as it is, exit code 1. */
export class CliError extends Error {}

/**
 * What a command will do, before it does it: `summary` is shown for
 * confirmation (`--yes` skips the question), `apply()` does it, once.
 */
export interface Plan<T> {
  summary: string[];
  apply(operator: Operator): Promise<T>;
}

/** A one-time password: shown once by the command, kept nowhere (only its hash is). */
export interface OneTimePassword {
  email: string;
  password: string;
}

/** 144 random bits as base64url: 24 characters, longer than any default policy asks. */
export const oneTimePassword = () => randomBytes(18).toString('base64url');

/** The audit entries' `details.operator`: who ran the command, from where. */
export const by = (operator: Operator) => ({
  operator: { user: operator.user, host: operator.host },
  via: 'cli',
});
