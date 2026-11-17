import { pgTable, text } from 'drizzle-orm/pg-core';
import { at, uuidPk } from '../database/columns.js';
import { encrypted, encryptedText } from '../encryption/encrypted-columns.js';

/**
 * Keys the app makes on its first start and keeps, so every instance (api
 * and workers) and every restart uses the same: the access tokens' signing
 * key, and later others. Global: they are the deployment's. A value is
 * encrypted with core/encryption when DATA_ENCRYPTION_KEYS is set
 * (secrets.service.ts), plaintext otherwise.
 */
export const appSecrets = pgTable('app_secrets', {
  id: uuidPk(),
  /** What the key is for (`jwt-signing-key`). */
  name: text('name').notNull().unique(),
  value: encryptedText('value').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

// Declared, not listed with @EncryptedColumns: encryption here is optional
// (the boot check would demand DATA_ENCRYPTION_KEYS), and Secrets moves a
// value to the current key itself when it reads it.
encrypted(appSecrets.value);
