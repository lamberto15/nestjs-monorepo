import { InjectTransaction, TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, max } from 'drizzle-orm';
import { databaseErrorKind } from '../../core/database/database-errors.js';
import type {
  Database,
  DatabaseTransactions,
} from '../../core/database/database.js';
import { type Principal, principalKey } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { ViewsService } from '../views/views.service.js';
import {
  type CreateFavoriteDto,
  MAX_FAVORITES,
  type ReorderFavoritesDto,
} from './favorites.schemas.js';
import { FavoritesRegistry } from './favorites.registry.js';
import { favorites } from './favorites.tables.js';

type Row = typeof favorites.$inferSelect;

/**
 * A person's favorites: records and pages they pin, in their order. Pinning
 * a record checks they can read it, and the list leaves out what they no
 * longer see or what is gone, so a label is never shown for a record they
 * may not read. Their own alone (no audit); a record deleted for good is
 * nobody's favorite any more.
 */
@Injectable()
export class FavoritesService {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
    private readonly records: Records,
    private readonly registry: FavoritesRegistry,
    private readonly views: ViewsService,
  ) {}

  /** The principal's favorites in their order, without what they no longer see. */
  async list(principal: Principal) {
    const rows = await this.db
      .select()
      .from(favorites)
      .where(eq(favorites.owner, principalKey(principal)))
      .orderBy(asc(favorites.position), asc(favorites.id));
    const seen = await Promise.all(
      rows.map((row) => this.sees(principal, row)),
    );
    return {
      items: rows.filter((_, i) => seen[i]).map((row) => this.item(row)),
    };
  }

  /** Pins something the principal sees, last in their list. */
  async add(principal: Principal, dto: CreateFavoriteDto) {
    await this.assertSees(principal, dto);
    const owner = principalKey(principal);
    return this.txHost
      .withTransaction(async () => {
        const [{ total, last }] = await this.db
          .select({ total: count(), last: max(favorites.position) })
          .from(favorites)
          .where(eq(favorites.owner, owner));
        if (total >= MAX_FAVORITES) {
          throw new BadRequestException(
            `At most ${MAX_FAVORITES} favorites: remove one first.`,
          );
        }
        const [row] = await this.db
          .insert(favorites)
          .values({ ...dto, owner, position: (last ?? -1) + 1 })
          .returning();
        return this.item(row!);
      })
      .catch((error: unknown) => {
        throw databaseErrorKind(error) === 'unique_violation'
          ? new ConflictException({
              code: 'favorite_exists',
              message: 'It is a favorite already.',
            })
          : error;
      });
  }

  /** Unpins one of the principal's favorites, or a 404. */
  async remove(principal: Principal, id: string) {
    const deleted = await this.db
      .delete(favorites)
      .where(
        and(eq(favorites.id, id), eq(favorites.owner, principalKey(principal))),
      )
      .returning({ id: favorites.id });
    if (deleted.length === 0) {
      throw new NotFoundException(`Favorite ${id} not found.`);
    }
  }

  /** Puts the principal's favorites in the given order: every one of them, once. */
  async reorder(principal: Principal, dto: ReorderFavoritesDto) {
    const owner = principalKey(principal);
    await this.txHost.withTransaction(async () => {
      const rows = await this.db
        .select({ id: favorites.id })
        .from(favorites)
        .where(eq(favorites.owner, owner));
      const mine = new Set(rows.map((row) => row.id));
      if (
        dto.ids.length !== mine.size ||
        new Set(dto.ids).size !== dto.ids.length ||
        !dto.ids.every((id) => mine.has(id))
      ) {
        throw new BadRequestException(
          'List every one of your favorites, once each.',
        );
      }
      for (const [position, id] of dto.ids.entries()) {
        await this.db
          .update(favorites)
          .set({ position })
          .where(and(eq(favorites.id, id), eq(favorites.owner, owner)));
      }
    });
    return this.list(principal);
  }

  /** The principal's favorite id of each record of `subject` among `ids` (null when none). */
  async favoriteIds(principal: Principal, subject: string, ids: string[]) {
    const result = new Map<string, string | null>(ids.map((id) => [id, null]));
    if (ids.length === 0) return result;
    const rows = await this.db
      .select({ id: favorites.id, target: favorites.target })
      .from(favorites)
      .where(
        and(
          eq(favorites.owner, principalKey(principal)),
          eq(favorites.kind, 'record'),
          eq(favorites.subject, subject),
          inArray(favorites.target, ids),
        ),
      );
    for (const row of rows) result.set(row.target, row.id);
    return result;
  }

  /** When records are gone for good: nobody's favorites any more. */
  /** A merge: whoever pinned the duplicate has the survivor pinned instead (once). */
  async merge(subject: string, from: string, to: string) {
    const moved = await this.db
      .delete(favorites)
      .where(
        and(
          eq(favorites.kind, 'record'),
          eq(favorites.subject, subject),
          eq(favorites.target, from),
        ),
      )
      .returning();
    if (moved.length > 0) {
      await this.db
        .insert(favorites)
        .values(
          moved.map(({ id: _id, ...favorite }) => ({
            ...favorite,
            target: to,
          })),
        )
        .onConflictDoNothing();
    }
  }

  async forget(subject: string, recordIds: readonly string[]) {
    await this.db
      .delete(favorites)
      .where(
        and(
          eq(favorites.kind, 'record'),
          eq(favorites.subject, subject),
          inArray(favorites.target, [...recordIds]),
        ),
      );
  }

  /** Whether the principal sees what a favorite points at (a page always: the menu gates pages). */
  private async sees(
    principal: Principal,
    favorite: Pick<Row, 'kind' | 'subject' | 'target'>,
  ) {
    try {
      await this.assertSees(principal, favorite);
      return true;
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof ForbiddenException
      ) {
        return false;
      }
      throw error;
    }
  }

  /** A 404 unless the principal can read the record (as reading it would). */
  private async assertSees(
    principal: Principal,
    favorite: Pick<Row, 'kind' | 'subject' | 'target'>,
  ) {
    if (favorite.kind === 'view') {
      // The views' own visibility: a 404 for a view they may not see.
      if (principal.kind === 'system') throw new ForbiddenException();
      await this.views.get(principal, favorite.target);
      return;
    }
    if (favorite.kind !== 'record') return;
    const record = this.registry.has(favorite.subject)
      ? this.records.find(favorite.subject)
      : undefined;
    if (!record) {
      throw new NotFoundException(`No records of ${favorite.subject}.`);
    }
    await record.store.findOne(favorite.target, { visibleTo: principal });
  }

  private item(row: Row) {
    return {
      id: row.id,
      kind: row.kind,
      subject: row.subject,
      target: row.target,
      label: row.label,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
