import { index } from 'drizzle-orm/pg-core';
import { uuidPk } from '../../../src/core/database/columns.js';
import { normalizers } from '../../../src/core/encryption/data-cipher.js';
import {
  blindIndexText,
  encrypted,
  encryptedText,
} from '../../../src/core/encryption/encrypted-columns.js';
import { tenantTable } from '../../../src/core/tenancy/tenant-tables.js';

/** A tenant table with an encrypted, indexed column, for the encryption-admin tests only. */
export const encryptedNotes = tenantTable(
  'test_encrypted_notes',
  {
    id: uuidPk(),
    body: encryptedText('body').notNull(),
    bodyIndex: blindIndexText('body_index').notNull(),
  },
  // A lookup by the blind index; the tenant's key uses it too.
  (t) => [index('test_encrypted_notes_body_idx').on(t.tenantId, t.bodyIndex)],
);
encrypted(encryptedNotes.body, {
  blindIndex: encryptedNotes.bodyIndex,
  normalize: normalizers.exact,
});
