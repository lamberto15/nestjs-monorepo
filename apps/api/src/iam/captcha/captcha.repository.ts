import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { appAttestKeys } from './captcha.tables.js';

/** The queries of the App Attest keys (one table of no tenant's), in the ambient transaction. */
@Injectable()
export class CaptchaRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** Stores a key; undefined when it is stored already. */
  async insertAppleKey(values: {
    keyId: string;
    appId: string;
    publicKey: string;
  }) {
    const [stored] = await this.db
      .insert(appAttestKeys)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: appAttestKeys.id });
    return stored;
  }

  async findAppleKey(keyId: string) {
    const [key] = await this.db
      .select()
      .from(appAttestKeys)
      .where(eq(appAttestKeys.keyId, keyId));
    return key;
  }

  /** Moves the key's counter up to `counter`; false when it is there already. */
  async countUp(id: string, counter: number) {
    const [counted] = await this.db
      .update(appAttestKeys)
      .set({ counter, updatedAt: new Date() })
      .where(and(eq(appAttestKeys.id, id), lt(appAttestKeys.counter, counter)))
      .returning({ id: appAttestKeys.id });
    return !!counted;
  }
}
