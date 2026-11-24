import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, max } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import { favorites } from './favorites.tables.js';

type NewFavorite = typeof favorites.$inferInsert;

/** The favorites' queries, in the caller's transaction and tenant. */
@Injectable()
export class FavoritesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** An owner's favorites in their order. */
  async listOf(owner: string) {
    return this.db
      .select()
      .from(favorites)
      .where(eq(favorites.owner, owner))
      .orderBy(asc(favorites.position), asc(favorites.id));
  }

  /** How many favorites the owner has, and the last position. */
  async countOf(owner: string) {
    const [row] = await this.db
      .select({ total: count(), last: max(favorites.position) })
      .from(favorites)
      .where(eq(favorites.owner, owner));
    return row!;
  }

  async insert(values: NewFavorite) {
    const [row] = await this.db.insert(favorites).values(values).returning();
    return row!;
  }

  /** Deletes one of the owner's favorites; whether there was one. */
  async delete(owner: string, id: string) {
    const deleted = await this.db
      .delete(favorites)
      .where(and(eq(favorites.id, id), eq(favorites.owner, owner)))
      .returning({ id: favorites.id });
    return deleted.length > 0;
  }

  async idsOf(owner: string) {
    const rows = await this.db
      .select({ id: favorites.id })
      .from(favorites)
      .where(eq(favorites.owner, owner));
    return rows.map((row) => row.id);
  }

  async setPosition(owner: string, id: string, position: number) {
    await this.db
      .update(favorites)
      .set({ position })
      .where(and(eq(favorites.id, id), eq(favorites.owner, owner)));
  }

  /** The owner's favorites of records of `subject` among `ids`. */
  async recordFavorites(owner: string, subject: string, ids: string[]) {
    return this.db
      .select({ id: favorites.id, target: favorites.target })
      .from(favorites)
      .where(
        and(
          eq(favorites.owner, owner),
          eq(favorites.kind, 'record'),
          eq(favorites.subject, subject),
          inArray(favorites.target, ids),
        ),
      );
  }

  /** Deletes every favorite of the given records, and returns them. */
  async deleteOfRecords(subject: string, targets: readonly string[]) {
    return this.db
      .delete(favorites)
      .where(
        and(
          eq(favorites.kind, 'record'),
          eq(favorites.subject, subject),
          inArray(favorites.target, [...targets]),
        ),
      )
      .returning();
  }

  /** Inserts favorites, skipping one the owner already has. */
  async insertMissing(rows: NewFavorite[]) {
    await this.db.insert(favorites).values(rows).onConflictDoNothing();
  }

  /** A person's favorites for their export, in their order. */
  async ofOwner(owner: string) {
    return this.db
      .select()
      .from(favorites)
      .where(eq(favorites.owner, owner))
      .orderBy(favorites.position);
  }

  async deleteOfOwner(owner: string) {
    await this.db.delete(favorites).where(eq(favorites.owner, owner));
  }
}
