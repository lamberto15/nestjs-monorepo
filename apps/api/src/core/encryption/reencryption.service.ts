import { Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, gt, isNotNull, isNull, notLike, or } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Database } from '../database/database.js';
import { DecryptionError } from './data-cipher.js';
import type { EncryptedColumn } from './encrypted-columns.js';
import { EncryptionService } from './encryption.service.js';

const BATCH = 500;

/** A value matching LIKE's wildcards literally (base64url keys hold `_`). */
const literal = (prefix: string) => prefix.replace(/[\\%_]/g, '\\$&');

/**
 * Moves rows over to the current keys after a rotation: every column found
 * by EncryptionService (`@EncryptedColumns`), in id order, 500 rows at a
 * time. A row is written back only where it still holds the value read, so a
 * request's write in between is never overwritten; a value that doesn't open
 * is reported, never changed. Idempotent: run it as often as wanted. Which
 * database it runs on (a tenant's, under RLS) and when (a schedule, a queue)
 * is the caller's: this only does the work.
 */
@Injectable()
export class ReencryptionService {
  private readonly logger = new Logger('Reencryption');

  constructor(private readonly encryption: EncryptionService) {}

  async run(db: Database) {
    const result = { rewritten: 0, failed: 0 };
    for (const entry of this.encryption.columns()) {
      const done = await this.column(db, entry);
      result.rewritten += done.rewritten;
      result.failed += done.failed;
    }
    return result;
  }

  /** How many rows of `entry` are still on an old key or format. */
  async stale(db: Database, entry: EncryptedColumn) {
    return (await this.page(db, entry, undefined, undefined)).length;
  }

  private async column(db: Database, entry: EncryptedColumn) {
    const result = { rewritten: 0, failed: 0 };
    const where = `${entry.bindingTable}.${entry.bindingColumn}`;
    let after: string | undefined;
    for (;;) {
      const rows = await this.page(db, entry, after, BATCH);
      for (const row of rows) {
        try {
          const next = this.encryption.rewrite(entry, row.value, row.tenantId);
          const set: Record<string, string> = { [entry.key]: next.value };
          if (entry.blindIndex && next.index) {
            set[entry.blindIndex.key] = next.index;
          }
          const written = await db
            .update(entry.table)
            .set(set)
            .where(and(eq(entry.id, row.id), eq(entry.column, row.value)))
            .returning({ id: entry.id });
          result.rewritten += written.length;
        } catch (error) {
          if (!(error instanceof DecryptionError)) {
            throw error;
          }
          result.failed += 1;
          this.logger.warn(`${where} row ${row.id}: ${error.reason}`);
        }
      }
      if (rows.length < BATCH) {
        return result;
      }
      after = rows[rows.length - 1].id;
    }
  }

  /** The stale rows of `entry` after id `after`, in id order. */
  private async page(
    db: Database,
    entry: EncryptedColumn,
    after: string | undefined,
    limit: number | undefined,
  ) {
    const prefix = this.encryption.currentPrefix();
    if (!prefix) {
      return [];
    }
    const indexPrefix = this.encryption.currentIndexPrefix();
    const stale: SQL[] = [notLike(entry.column, `${literal(prefix)}%`)];
    if (entry.blindIndex && indexPrefix) {
      stale.push(
        isNull(entry.blindIndex.column),
        notLike(entry.blindIndex.column, `${literal(indexPrefix)}%`),
      );
    }
    const query = db
      .select({
        id: entry.id as PgColumn,
        value: entry.column,
        tenantId: entry.tenantColumn ?? entry.id,
      })
      .from(entry.table)
      .where(
        and(
          isNotNull(entry.column),
          or(...stale),
          after ? gt(entry.id, after) : undefined,
        ),
      )
      .orderBy(asc(entry.id));
    const rows = await (limit ? query.limit(limit) : query);
    return rows.map((row) => ({
      id: String(row.id),
      value: String(row.value),
      tenantId: entry.tenantColumn ? String(row.tenantId) : null,
    }));
  }
}
