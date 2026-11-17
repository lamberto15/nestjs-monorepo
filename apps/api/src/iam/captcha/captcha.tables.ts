import { bigint, pgTable, text } from 'drizzle-orm/pg-core';
import { timestamps, uuidPk } from '../../core/database/columns.js';

/**
 * iOS installs whose App Attest key Apple vouched for (global: a key vouches
 * for the app, not for a person or a tenant). Each later assertion is signed
 * with the key and its counter must count up.
 */
export const appAttestKeys = pgTable('app_attest_keys', {
  id: uuidPk(),
  /** The key id App Attest names (SHA-256 of the public key), base64url. */
  keyId: text('key_id').notNull().unique(),
  /** The app it was attested for: `TEAMID.bundle.identifier`. */
  appId: text('app_id').notNull(),
  /** The public key, SPKI DER, base64url. */
  publicKey: text('public_key').notNull(),
  /** The assertion counter last seen; an assertion must count higher. */
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  ...timestamps(),
});
