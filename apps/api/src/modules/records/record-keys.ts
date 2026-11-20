import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { RecordDeclaration } from './record.js';
import {
  declarationOf,
  includeNameOf,
  recordKeyOf,
  recordTableOf,
  relationsFrom,
} from './record-relations.js';

/**
 * Records by their keys (a declaration's `key`, `keyWithin`): what files and
 * numbers name them by. A key unique within a parent is written as the path
 * of its parents' keys, `QWERT/HL/PTP`; without a declared key, the id.
 * Plain functions on the caller's database (its tenant's): whether the
 * caller may read a record is the caller's to check.
 */

type Db = Pick<Database, 'select'>;

const SEPARATOR = '/';

/** The declaration `keyWithin` points at: a key's parent. */
function parentOf(declaration: RecordDeclaration) {
  if (!declaration.keyWithin) return undefined;
  const relation = relationsFrom(declaration).find(
    (r) => r.field === declaration.keyWithin,
  );
  const subject = relation?.target();
  return subject ? declarationOf(subject) : undefined;
}

function columns(declaration: RecordDeclaration) {
  const table = recordTableOf(declaration) as unknown as Record<
    string,
    AnyPgColumn
  > &
    PgTable;
  return { table, id: table.id!, deletedAt: table.deletedAt };
}

/** The keys of these records, by id: their key path, else their id. */
export async function keysOf(
  db: Db,
  declaration: RecordDeclaration,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  const key = recordKeyOf(declaration);
  if (key === 'id' || wanted.length === 0) {
    return new Map(wanted.map((id) => [id, id]));
  }
  const { table, id } = columns(declaration);
  const within = declaration.keyWithin;
  const rows = (await db
    .select({
      id,
      key: table[key]!,
      ...(within && { parent: table[within]! }),
    })
    .from(table)
    .where(inArray(id, wanted))) as {
    id: string;
    key: string | null;
    parent?: string | null;
  }[];
  const parent = parentOf(declaration);
  const parents =
    parent && within
      ? await keysOf(
          db,
          parent,
          rows.flatMap((row) => (row.parent ? [row.parent] : [])),
        )
      : new Map<string, string>();
  return new Map(
    rows.map((row) => {
      const own = row.key ?? row.id;
      const above = row.parent ? parents.get(row.parent) : undefined;
      return [row.id, above ? `${above}${SEPARATOR}${own}` : own];
    }),
  );
}

/** The live record a key names (its path for a key within a parent), or null. */
export async function idOfKey(
  db: Db,
  declaration: RecordDeclaration,
  text: string,
): Promise<string | null> {
  const key = recordKeyOf(declaration);
  const { table, id, deletedAt } = columns(declaration);
  const parent = parentOf(declaration);
  let own = text;
  let parentId: string | null | undefined;
  if (key !== 'id' && parent && declaration.keyWithin) {
    const at = text.lastIndexOf(SEPARATOR);
    if (at < 0) return null;
    own = text.slice(at + 1);
    parentId = await idOfKey(db, parent, text.slice(0, at));
    if (!parentId) return null;
  }
  if (key === 'id' && !UUID.test(own)) return null;
  const [row] = (await db
    .select({ id })
    .from(table)
    .where(
      and(
        eq(table[key]!, own),
        parentId ? eq(table[declaration.keyWithin!]!, parentId) : undefined,
        deletedAt ? isNull(deletedAt) : undefined,
      ),
    )
    .limit(1)) as { id: string }[];
  return row?.id ?? null;
}

/**
 * What a number may print of a record's references (naming series):
 * each reference's own key (`product`: HL) and its parents' up the key
 * path (`product_client`: QWERT), from a create body's ids.
 */
export async function referenceKeyValues(
  db: Db,
  declaration: RecordDeclaration,
  values: Readonly<Record<string, unknown>>,
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const relation of relationsFrom(declaration)) {
    const value = values[relation.field];
    const subject = relation.target();
    const target = subject ? declarationOf(subject) : undefined;
    if (typeof value !== 'string' || !target) continue;
    await ownKeys(db, target, value, includeNameOf(relation.field), found);
  }
  return found;
}

/** The record's own key (not its path) as `name`, then its parent's as `name_parent`, up. */
async function ownKeys(
  db: Db,
  declaration: RecordDeclaration,
  recordId: string,
  name: string,
  found: Record<string, string>,
) {
  const key = recordKeyOf(declaration);
  const { table, id } = columns(declaration);
  const within = declaration.keyWithin;
  const [row] = (await db
    .select({
      key: table[key]!,
      ...(within && { parent: table[within]! }),
    })
    .from(table)
    .where(eq(id, recordId))
    .limit(1)) as { key: string | null; parent?: string | null }[];
  if (!row) return;
  found[name] = row.key ?? recordId;
  const parent = parentOf(declaration);
  if (parent && within && row.parent) {
    await ownKeys(
      db,
      parent,
      row.parent,
      `${name}_${includeNameOf(within)}`,
      found,
    );
  }
}

/** The names referenceKeyValues() gives, for a record's numbering patterns. */
export function referenceKeyNames(declaration: RecordDeclaration): string[] {
  return relationsFrom(declaration).flatMap((relation) => {
    const subject = relation.target();
    const names: string[] = [];
    let name = includeNameOf(relation.field);
    let target = subject ? declarationOf(subject) : undefined;
    while (target) {
      names.push(name);
      if (!target.keyWithin) break;
      name = `${name}_${includeNameOf(target.keyWithin)}`;
      target = parentOf(target);
    }
    return names;
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
