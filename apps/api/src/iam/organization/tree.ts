import { and, eq, getTableName, inArray, notInArray, sql } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { organizationalUnitClosure } from './organization.tables.js';

/** Builds subqueries with no connection: they run inside the caller's query. */
const subquery = new QueryBuilder();

/**
 * The units' closure table (organization.tables.ts): one row per
 * (ancestor, descendant) pair, a unit being its own ancestor at depth 0.
 * "Everything under X" is one indexed lookup at any depth; moving a
 * subtree is two statements. Every method runs in the caller's
 * transaction (`db`), in its tenant.
 */
export class UnitTree {
  private readonly closure = organizationalUnitClosure;

  /** Records a new unit under `parentId` (null: a root), in its insert's transaction. */
  async add(db: Database, id: string, parentId: string | null) {
    await this.lock(db);
    await db
      .insert(this.closure)
      .values({ ancestorId: id, descendantId: id, depth: 0 });
    if (parentId) {
      // Every ancestor of the parent is one level further from the unit.
      const { closure } = this;
      await db.insert(closure).select(
        db
          .select({
            tenantId: closure.tenantId,
            ancestorId: closure.ancestorId,
            descendantId: sql<string>`${id}::uuid`.as('descendant_id'),
            depth: sql<number>`${closure.depth} + 1`.as('depth'),
          })
          .from(closure)
          .where(eq(closure.descendantId, parentId)),
      );
    }
  }

  /**
   * Moves `id` and everything under it below `parentId` (null: to the
   * root). Refuses a move under itself or its own descendants (a cycle).
   */
  async move(db: Database, id: string, parentId: string | null) {
    // Two concurrent moves (A under B, B under A) would each pass the cycle check alone.
    await this.lock(db);
    if (parentId && (await this.isUnder(db, parentId, id))) {
      throw new TreeCycleError(id, parentId);
    }
    const { closure } = this;
    const subtree = db
      .select({ id: closure.descendantId })
      .from(closure)
      .where(eq(closure.ancestorId, id));
    // Detach the subtree from its old ancestors (it keeps its own inner paths)…
    await db
      .delete(closure)
      .where(
        and(
          inArray(closure.descendantId, subtree),
          notInArray(closure.ancestorId, subtree),
        ),
      );
    // …then attach it under every ancestor of the new parent.
    if (parentId) {
      const above = alias(closure, 'above');
      const below = alias(closure, 'below');
      await db.insert(closure).select(
        db
          .select({
            tenantId: above.tenantId,
            ancestorId: above.ancestorId,
            descendantId: below.descendantId,
            depth: sql<number>`${above.depth} + ${below.depth} + 1`.as('depth'),
          })
          .from(above)
          .crossJoin(below)
          .where(
            and(eq(above.descendantId, parentId), eq(below.ancestorId, id)),
          ),
      );
    }
  }

  /** Whether `id` is `ancestorId` or below it. */
  async isUnder(db: Database, id: string, ancestorId: string) {
    const [row] = await db
      .select({ depth: this.closure.depth })
      .from(this.closure)
      .where(
        and(
          eq(this.closure.ancestorId, ancestorId),
          eq(this.closure.descendantId, id),
        ),
      );
    return !!row;
  }

  /** The ids at or above this unit, as a subquery: `inArray(column, tree.ancestors(id))`. */
  ancestors(id: string) {
    return subquery
      .select({ id: this.closure.ancestorId })
      .from(this.closure)
      .where(eq(this.closure.descendantId, id));
  }

  /** The ids at or below this unit, as a subquery: `inArray(column, tree.descendants(id))`. */
  descendants(id: string) {
    return subquery
      .select({ id: this.closure.descendantId })
      .from(this.closure)
      .where(eq(this.closure.ancestorId, id));
  }

  /**
   * One change of the tree at a time, until the transaction ends. An
   * advisory lock: Drizzle has no API for it.
   */
  private async lock(db: Database) {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtext(${getTableName(this.closure)}))`,
    );
  }
}

/** A move that would put a unit under itself. */
export class TreeCycleError extends Error {
  constructor(id: string, parentId: string) {
    super(`${parentId} is ${id} or below it: the move would make a cycle.`);
  }
}
