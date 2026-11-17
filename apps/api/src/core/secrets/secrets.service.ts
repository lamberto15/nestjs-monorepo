import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { EncryptionService } from '../encryption/encryption.service.js';
import { appSecrets } from './secrets.tables.js';

/**
 * Secrets the app generates once and shares through the database
 * (README.md). Outside any transaction (`@InjectDrizzle()`): a key made at
 * boot must stay made, whatever rolls back around it.
 */
@Injectable()
export class Secrets {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * The secret `name`, made with `generate()` the first time any instance
   * asks. Instances starting together agree: the name is unique, and the
   * one stored first wins. With DATA_ENCRYPTION_KEYS set it is stored
   * encrypted, and a value stored in the clear (before the keys were set)
   * or under an older key is rewritten under the current one.
   */
  async loadOrCreate(name: string, generate: () => string): Promise<string> {
    await this.db
      .insert(appSecrets)
      .values({ name, value: this.seal(generate()) })
      .onConflictDoNothing({ target: appSecrets.name });
    const [row] = await this.db
      .select({ value: appSecrets.value })
      .from(appSecrets)
      .where(eq(appSecrets.name, name));
    const stored = row!.value;
    const sealed = this.encryption.keyIdOf(stored) !== undefined;
    const plaintext = sealed
      ? this.encryption.decrypt(appSecrets.value, stored)
      : stored;
    const current = this.encryption.currentKeyId;
    if (current && this.encryption.keyIdOf(stored) !== current) {
      // Conditional: of two instances doing it at once, one writes.
      await this.db
        .update(appSecrets)
        .set({ value: this.seal(plaintext) })
        .where(and(eq(appSecrets.name, name), eq(appSecrets.value, stored)));
    }
    return plaintext;
  }

  private seal(plaintext: string) {
    return this.encryption.currentKeyId
      ? this.encryption.encrypt(appSecrets.value, plaintext)
      : plaintext;
  }
}
