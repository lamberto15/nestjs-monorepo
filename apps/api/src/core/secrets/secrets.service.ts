import { Injectable } from '@nestjs/common';
import { EncryptionService } from '../encryption/encryption.service.js';
import { SecretsRepository } from './secrets.repository.js';
import { appSecrets } from './secrets.tables.js';

/**
 * Secrets the app generates once and shares through the database
 * (README.md), outside any transaction (SecretsRepository).
 */
@Injectable()
export class Secrets {
  constructor(
    private readonly repository: SecretsRepository,
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
    await this.repository.insertIfAbsent(name, this.seal(generate()));
    const stored = (await this.repository.valueOf(name))!;
    const sealed = this.encryption.keyIdOf(stored) !== undefined;
    const plaintext = sealed
      ? this.encryption.decrypt(appSecrets.value, stored)
      : stored;
    const current = this.encryption.currentKeyId;
    if (current && this.encryption.keyIdOf(stored) !== current) {
      // Conditional: of two instances doing it at once, one writes.
      await this.repository.replace(name, stored, this.seal(plaintext));
    }
    return plaintext;
  }

  private seal(plaintext: string) {
    return this.encryption.currentKeyId
      ? this.encryption.encrypt(appSecrets.value, plaintext)
      : plaintext;
  }
}
