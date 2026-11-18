import { createHash } from 'node:crypto';

/**
 * A password's SHA-1 in upper-case hex: what the breach check's range API
 * (k-anonymity) is defined on, and all `auth.password-verified` carries, so
 * no listener ever holds the plaintext. Unsalted and fast: in process only,
 * never stored, logged or queued.
 */
export const passwordSha1 = (password: string) =>
  createHash('sha1') // NOSONAR S4790: the range API is defined on SHA-1, not a choice of ours
    .update(password, 'utf8')
    .digest('hex')
    .toUpperCase();
