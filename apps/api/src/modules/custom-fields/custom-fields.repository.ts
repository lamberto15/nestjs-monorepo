import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  max,
  sql,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import type { RecordTable } from '../records/record.js';
import { customFilterFields } from './custom-field.list.js';
import type { CustomFieldDefinition } from './custom-field.types.js';
import {
  customFieldDefinitions as d,
  customFieldValues as v,
} from './custom-fields.tables.js';

type NewDefinition = typeof d.$inferInsert;
type Values = Record<string, unknown>;

/**
 * The custom fields' queries: the definitions and the values records hold,
 * in the caller's transaction and tenant.
 */
@Injectable()
export class CustomFieldsRepository {
  constructor(@InjectTransaction() private readonly db: Database) {}

  /** A subject's definitions in their order; inactive ones too when asked. */
  async definitions(subject: string, includeInactive: boolean) {
    const rows = await this.db
      .select()
      .from(d)
      .where(
        and(
          eq(d.subject, subject),
          includeInactive ? undefined : eq(d.active, true),
        ),
      )
      .orderBy(asc(d.position), asc(d.key));
    return rows as CustomFieldDefinition[];
  }

  async findById(id: string) {
    const [field] = await this.db.select().from(d).where(eq(d.id, id));
    return field as CustomFieldDefinition | undefined;
  }

  /** The last position among a subject's fields, or null. */
  async lastPosition(subject: string) {
    const [{ last }] = await this.db
      .select({ last: max(d.position) })
      .from(d)
      .where(eq(d.subject, subject));
    return last;
  }

  async countActive(subject: string) {
    const [{ active }] = await this.db
      .select({ active: count() })
      .from(d)
      .where(and(eq(d.subject, subject), eq(d.active, true)));
    return active;
  }

  async insert(values: NewDefinition) {
    const [row] = await this.db.insert(d).values(values).returning();
    return row as CustomFieldDefinition;
  }

  async update(id: string, values: Partial<NewDefinition>) {
    const [row] = await this.db
      .update(d)
      .set(values)
      .where(eq(d.id, id))
      .returning();
    return row as CustomFieldDefinition;
  }

  async setPosition(id: string, position: number) {
    await this.db
      .update(d)
      .set({ position, updatedAt: new Date() })
      .where(eq(d.id, id));
  }

  /**
   * How many records of `table` hold each key (`r<i>`) and how many of
   * those are in the recycle bin (`d<i>`): one query over the values.
   */
  async valueCounts(subject: string, table: RecordTable, keys: string[]) {
    const deletedAt = table.deletedAt;
    const holds = (key: string) => sql`${v.values} ? ${key}::text`;
    const counted = (condition: ReturnType<typeof and>) =>
      sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
    const columns = Object.fromEntries(
      keys.flatMap((key, index) => [
        [
          `r${index}`,
          counted(and(holds(key), deletedAt ? isNull(deletedAt) : undefined)),
        ],
        [
          `d${index}`,
          deletedAt
            ? counted(and(holds(key), isNotNull(deletedAt)))
            : sql<number>`0`.mapWith(Number),
        ],
      ]),
    );
    const [row] = (await this.db
      .select(columns)
      .from(v)
      .innerJoin(table as unknown as PgTable, eq(table.id, v.recordId))
      .where(eq(v.subject, subject))) as Record<string, number>[];
    return row;
  }

  /** Whether any record holds a value for `key` (or this value: a choice), on the GIN index. */
  async holdsValues(subject: string, key: string, value?: unknown) {
    const condition =
      value === undefined
        ? sql`${v.values} ? ${key}::text`
        : sql`${v.values} @> ${JSON.stringify({ [key]: value })}::jsonb`;
    const rows = await this.db
      .select({ id: v.id })
      .from(v)
      .where(and(eq(v.subject, subject), condition))
      .limit(1);
    return rows.length > 0;
  }

  /** The values stored for these records. */
  async valuesOf(subject: string, ids: readonly string[]) {
    return this.db
      .select({ recordId: v.recordId, values: v.values })
      .from(v)
      .where(and(eq(v.subject, subject), inArray(v.recordId, [...ids])));
  }

  async insertValues(subject: string, recordId: string, values: Values) {
    await this.db.insert(v).values({ subject, recordId, values });
  }

  async saveValues(subject: string, recordId: string, values: Values) {
    await this.db
      .insert(v)
      .values({ subject, recordId, values })
      .onConflictDoUpdate({
        target: [v.tenantId, v.subject, v.recordId],
        set: { values, updatedAt: new Date() },
      });
  }

  async deleteValues(subject: string, ids: readonly string[]) {
    await this.db
      .delete(v)
      .where(and(eq(v.subject, subject), inArray(v.recordId, [...ids])));
  }

  /** The subject's fields as list fields: their subqueries are built on this database. */
  filterFields(
    definitions: readonly CustomFieldDefinition[],
    subject: string,
    table: RecordTable,
  ) {
    return customFilterFields(definitions, { db: this.db, subject, table });
  }
}
