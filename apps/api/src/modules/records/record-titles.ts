import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { and, inArray, isNull } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import type { RecordDeclaration } from './record.js';
import {
  recordParentField,
  relationsFrom,
  relationTitle,
} from './record-relations.js';
import { Records } from './records.service.js';

/** Between a parent's title and its record's: `Acme · Standard plan · Open`. */
export const TITLE_SEPARATOR = ' · ';

/** Parents named above a record at most: a declaration that refers in a ring still ends. */
const MAX_PARENTS = 4;

/**
 * What a record is called where people pick or read it: its title field
 * (relationTitle()), after its parent's title when it has a parent
 * (recordParentField(): the reference a field is unique within). Siblings
 * of the same name under different parents then read apart: "Standard plan"
 * of two companies is "Acme · Standard plan" and "Globex · Standard plan". The one
 * definition the options route (pickers, cells, filter chips) and
 * `?include=` share.
 */
@Injectable()
export class RecordTitles {
  constructor(
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  /**
   * The title field of `subject` the caller may read on every record, or
   * null: a title shown on some records only would tell what the others
   * hide.
   */
  async titleField(principal: Principal, subject: string) {
    const declaration = this.records.find(subject)?.declaration;
    const named = declaration ? relationTitle(declaration) : null;
    if (!named) return null;
    const hidden = await this.hidden(principal, subject);
    return hidden.has(named) ? null : named;
  }

  /**
   * The titles of these ids of `subject`, each with its parents' before it:
   * an id the caller may not read, or that is deleted, is not in the map;
   * one without a readable title maps to null. A parent the caller may not
   * read is left out of the title.
   */
  async of(
    principal: Principal,
    subject: string,
    ids: readonly string[],
    depth = 0,
  ): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    const record = this.records.find(subject);
    if (!record || ids.length === 0) return found;
    const declaration = record.declaration;
    const table = record.feature.table as unknown as PgTable &
      Record<string, AnyPgColumn>;
    const hidden = await this.hidden(principal, subject);
    const named = relationTitle(declaration);
    const title = named && !hidden.has(named) ? table[named] : undefined;
    const parent = depth < MAX_PARENTS ? this.parentOf(declaration) : null;
    const parentColumn =
      parent && !hidden.has(parent.field) ? table[parent.field] : undefined;
    const rows = (await this.txHost.tx
      .select({
        id: table.id!,
        ...(title && { title }),
        ...(parentColumn && { parent: parentColumn }),
      })
      .from(table)
      .where(
        and(
          inArray(table.id!, [...new Set(ids)]),
          table.deletedAt ? isNull(table.deletedAt) : undefined,
          await this.access.sqlFilter(principal, subject, 'read'),
        ),
      )) as { id: string; title?: unknown; parent?: unknown }[];
    const parentIds = rows.flatMap((row) =>
      typeof row.parent === 'string' ? [row.parent] : [],
    );
    const parents =
      parent && parentIds.length
        ? await this.of(principal, parent.subject, parentIds, depth + 1)
        : new Map<string, string | null>();
    for (const row of rows) {
      const own = typeof row.title === 'string' ? row.title : null;
      const above =
        typeof row.parent === 'string' ? parents.get(row.parent) : null;
      found.set(
        row.id,
        own && above ? `${above}${TITLE_SEPARATOR}${own}` : own,
      );
    }
    return found;
  }

  /** The parent reference of a record and the subject it refers to, or null. */
  private parentOf(declaration: RecordDeclaration) {
    const field = recordParentField(declaration);
    const subject =
      field &&
      relationsFrom(declaration)
        .find((relation) => relation.field === field)
        ?.target();
    return field && subject ? { field, subject } : null;
  }

  /** The fields the caller may read on no record, or on some only. */
  private async hidden(principal: Principal, subject: string) {
    const [denied, conditional] = await Promise.all([
      this.access.deniedFields(principal, 'read', subject),
      this.access.conditionalFields(principal, 'read', subject),
    ]);
    return new Set([...denied, ...conditional]);
  }
}
