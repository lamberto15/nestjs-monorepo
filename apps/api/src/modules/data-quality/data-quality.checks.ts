import { and, asc, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { ExpressionError } from '../expressions/expression.js';
import {
  type RecordRow,
  type RecordTable,
  recordView,
} from '../records/record.js';
import { relationsFrom } from '../records/record-relations.js';
import type { DataQualityRegistration } from './data-quality.registry.js';
import type {
  FindingDetail,
  QualityCheck,
  QualitySeverity,
} from './data-quality.tables.js';

/** The duplicates a finding names, first by id: a value shared by thousands names a few. */
export const DUPLICATES_KEPT = 50;

/** A problem found on a record now. */
export interface Found {
  recordId: string;
  check: QualityCheck;
  field: string;
  severity: QualitySeverity;
  detail: FindingDetail | null;
}

/** Null, or text that is blank once trimmed: nothing there. */
const isEmpty = (value: unknown) =>
  value == null || (typeof value === 'string' && value.trim() === '');

/**
 * The problems these rows of a record have now: the declared checks
 * (data-quality.registry.ts) and, always, references to records in the
 * recycle bin. `rows` are live records as the table holds them; the
 * duplicate check compares them with every live record of the table.
 */
export async function findProblems(
  db: Database,
  registration: DataQualityRegistration,
  table: RecordTable,
  rows: readonly RecordRow[],
): Promise<Found[]> {
  const found: Found[] = [];
  for (const field of registration.recommended) {
    for (const row of rows) {
      if (isEmpty(row[field])) {
        found.push({
          recordId: row.id,
          check: 'missing',
          field,
          severity: 'suggestion',
          detail: null,
        });
      }
    }
  }
  // A missing record can't be referred to (the key); one in the recycle bin can.
  for (const relation of relationsFrom(registration.record)) {
    const target = relation.targetTable();
    if (!target.deletedAt) continue;
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          row[relation.field] ? [row[relation.field] as string] : [],
        ),
      ),
    ];
    if (ids.length === 0) continue;
    const binned = new Set(
      (
        await db
          .select({ id: target.id })
          .from(target as unknown as PgTable)
          .where(and(inArray(target.id, ids), isNotNull(target.deletedAt)))
      ).map((row) => row.id as string),
    );
    for (const row of rows) {
      const to = row[relation.field] as string | null;
      if (to && binned.has(to)) {
        found.push({
          recordId: row.id,
          check: 'reference',
          field: relation.field,
          severity: 'error',
          detail: { referencedId: to },
        });
      }
    }
  }
  for (const field of registration.duplicates) {
    const column = table[field]!;
    // Drizzle has no lower() or trim(): the key is a case-folded, trimmed value.
    const key = sql<string>`lower(trim(${column}))`;
    const keys = [
      ...new Set(
        rows.flatMap((row) =>
          isEmpty(row[field])
            ? []
            : [(row[field] as string).trim().toLowerCase()],
        ),
      ),
    ];
    if (keys.length === 0) continue;
    const same = await db
      .select({ id: table.id, key })
      .from(table as unknown as PgTable)
      .where(
        and(
          table.deletedAt ? isNull(table.deletedAt) : undefined,
          inArray(key, keys),
        ),
      )
      .orderBy(asc(table.id));
    for (const row of rows) {
      if (isEmpty(row[field])) continue;
      const mine = (row[field] as string).trim().toLowerCase();
      const others = same
        .filter((s) => s.key === mine && s.id !== row.id)
        .slice(0, DUPLICATES_KEPT)
        .map((s) => s.id as string);
      if (others.length) {
        found.push({
          recordId: row.id,
          check: 'duplicate',
          field,
          severity: 'suggestion',
          detail: { duplicateOf: others },
        });
      }
    }
  }
  for (const rule of registration.rules) {
    for (const row of rows) {
      const view = recordView(registration.record, row) as Record<
        string,
        unknown
      >;
      let holds: unknown;
      try {
        holds = rule.compiled.evaluate(view);
      } catch (error) {
        // A value it can't compute (a division by zero) is no finding: the rule says nothing of it.
        if (error instanceof ExpressionError) continue;
        throw error;
      }
      if (holds === false) {
        found.push({
          recordId: row.id,
          check: 'rule',
          field: rule.name,
          severity: rule.severity ?? 'suggestion',
          detail: rule.message ? { message: rule.message } : null,
        });
      }
    }
  }
  return found;
}
