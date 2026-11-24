import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { appSecrets } from './secrets.tables.js';

/**
 * The queries of `app_secrets`. Outside any transaction (`@InjectDrizzle()`):
 * a key made at boot must stay made, whatever rolls back around it.
 */
@Injectable()
export class SecretsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Stores `value` under `name` unless one is there: the first stored wins. */
  async insertIfAbsent(name: string, value: string) {
    await this.db
      .insert(appSecrets)
      .values({ name, value })
      .onConflictDoNothing({ target: appSecrets.name });
  }

  async valueOf(name: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ value: appSecrets.value })
      .from(appSecrets)
      .where(eq(appSecrets.name, name));
    return row?.value;
  }

  /** Replaces the value only where it is still `stored`. */
  async replace(name: string, stored: string, value: string) {
    await this.db
      .update(appSecrets)
      .set({ value })
      .where(and(eq(appSecrets.name, name), eq(appSecrets.value, stored)));
  }
}
