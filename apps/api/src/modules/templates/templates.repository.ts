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
import { TEMPLATE_LIST } from './template.list.js';
import { recordTemplates } from './templates.tables.js';

/** Who sees templates: their own key, and the units they belong to. */
export interface TemplateSeer {
  owner: string;
  unitIds: string[];
}

/**
 * The record templates' queries, in the caller's tenant and transaction
 * (`@InjectTransaction()`).
 */
@Injectable()
export class TemplatesRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A page of the templates `seer` sees, of these subjects, and the total when asked. */
  page(seer: TemplateSeer, subjects: string[], query: ListQuery) {
    const where = and(
      this.visibleTo(seer),
      subjects.length ? inArray(recordTemplates.subject, subjects) : sql`false`,
      TEMPLATE_LIST.where(query),
    );
    return Promise.all([
      this.db
        // With the sort values the cursor needs (lower(name)); pick() drops them.
        .select({
          ...getColumns(recordTemplates),
          ...TEMPLATE_LIST.sortSelect(query),
        })
        .from(recordTemplates)
        .where(and(where, afterCursor(recordTemplates.id, query)))
        .orderBy(...pageOrder(recordTemplates.id, query))
        .limit(query.limit + 1)
        .offset(pageOffset(query)),
      countPage(this.db, recordTemplates, where, query),
    ]);
  }

  async findVisible(seer: TemplateSeer, id: string) {
    const [row] = await this.db
      .select()
      .from(recordTemplates)
      .where(and(eq(recordTemplates.id, id), this.visibleTo(seer)));
    return row;
  }

  async insert(values: typeof recordTemplates.$inferInsert) {
    const [created] = await this.db
      .insert(recordTemplates)
      .values(values)
      .returning();
    return created!;
  }

  async update(
    id: string,
    values: Partial<typeof recordTemplates.$inferInsert>,
  ) {
    const [updated] = await this.db
      .update(recordTemplates)
      .set(values)
      .where(eq(recordTemplates.id, id))
      .returning();
    return updated!;
  }

  async delete(id: string) {
    await this.db.delete(recordTemplates).where(eq(recordTemplates.id, id));
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
      .select({ templates: count() })
      .from(recordTemplates)
      .where(eq(recordTemplates.owner, owner));
    return row?.templates ?? 0;
  }

  ownedBy(owner: string) {
    return this.db
      .select()
      .from(recordTemplates)
      .where(eq(recordTemplates.owner, owner));
  }

  /** An owner's private templates deleted, the rest handed to `to`. */
  async eraseOwner(owner: string, to: string) {
    await this.db
      .delete(recordTemplates)
      .where(
        and(
          eq(recordTemplates.owner, owner),
          eq(recordTemplates.visibility, 'private'),
        ),
      );
    await this.db
      .update(recordTemplates)
      .set({ owner: to })
      .where(eq(recordTemplates.owner, owner));
  }

  /** Theirs, their units', the tenant's. */
  private visibleTo({ owner, unitIds }: TemplateSeer) {
    return or(
      // Theirs whatever it is shared with: an administrator shares with a unit they aren't in.
      eq(recordTemplates.owner, owner),
      eq(recordTemplates.visibility, 'tenant'),
      unitIds.length
        ? and(
            eq(recordTemplates.visibility, 'unit'),
            inArray(recordTemplates.unitId, unitIds),
          )
        : undefined,
    )!;
  }
}
