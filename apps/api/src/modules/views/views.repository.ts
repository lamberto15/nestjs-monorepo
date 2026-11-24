import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, count, eq, getColumns, inArray, or, sql } from 'drizzle-orm';
import type { Database } from '../../core/database/database.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  afterCursor,
  countPage,
  pageOffset,
  pageOrder,
} from '../../core/http/pagination.js';
import { organizationalUnits } from '../../iam/organization/organization.tables.js';
import { VIEW_LIST } from './view.list.js';
import { savedViews } from './views.tables.js';

/** Who sees views: their own key, and the units they belong to. */
export interface ViewSeer {
  owner: string;
  unitIds: string[];
}

/**
 * The saved views' queries, in the caller's tenant and transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class ViewsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of the views `seer` sees, of these subjects, and the total when asked. */
  page(seer: ViewSeer, subjects: string[], query: ListQuery) {
    const where = and(
      this.visibleTo(seer),
      subjects.length ? inArray(savedViews.subject, subjects) : sql`false`,
      VIEW_LIST.where(query),
    );
    return Promise.all([
      this.db
        // With the sort values the cursor needs (lower(name)); pick() drops them.
        .select({
          ...getColumns(savedViews),
          ...VIEW_LIST.sortSelect(query),
        })
        .from(savedViews)
        .where(and(where, afterCursor(savedViews.id, query)))
        .orderBy(...pageOrder(savedViews.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, savedViews, where, query),
    ]);
  }

  async findVisible(seer: ViewSeer, id: string) {
    const [row] = await this.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.id, id), this.visibleTo(seer)));
    return row;
  }

  async insert(values: typeof savedViews.$inferInsert) {
    const [created] = await this.db
      .insert(savedViews)
      .values(values)
      .returning();
    return created!;
  }

  async update(id: string, values: Partial<typeof savedViews.$inferInsert>) {
    const [updated] = await this.db
      .update(savedViews)
      .set(values)
      .where(eq(savedViews.id, id))
      .returning();
    return updated!;
  }

  async delete(id: string) {
    await this.db.delete(savedViews).where(eq(savedViews.id, id));
  }

  /** The unit's id as stored, if there is one. */
  async findUnitId(id: string) {
    const [unit] = await this.db
      .select({ id: organizationalUnits.id })
      .from(organizationalUnits)
      .where(eq(organizationalUnits.id, id));
    return unit?.id;
  }

  async countOwnedBy(owner: string) {
    const [row] = await this.db
      .select({ views: count() })
      .from(savedViews)
      .where(eq(savedViews.owner, owner));
    return row?.views ?? 0;
  }

  ownedBy(owner: string) {
    return this.db.select().from(savedViews).where(eq(savedViews.owner, owner));
  }

  /** An owner's private views deleted, the rest handed to `to`. */
  async eraseOwner(owner: string, to: string) {
    await this.db
      .delete(savedViews)
      .where(
        and(eq(savedViews.owner, owner), eq(savedViews.visibility, 'private')),
      );
    await this.db
      .update(savedViews)
      .set({ owner: to })
      .where(eq(savedViews.owner, owner));
  }

  /** Theirs, their units', the tenant's. */
  private visibleTo({ owner, unitIds }: ViewSeer) {
    return or(
      // Theirs whatever it is shared with: an administrator shares with a unit they aren't in.
      eq(savedViews.owner, owner),
      eq(savedViews.visibility, 'tenant'),
      unitIds.length
        ? and(
            eq(savedViews.visibility, 'unit'),
            inArray(savedViews.unitId, unitIds),
          )
        : undefined,
    )!;
  }
}
