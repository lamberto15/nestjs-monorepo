import { TransactionHost } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, getColumns } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DatabaseTransactions } from '../../core/database/database.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  headline,
  matches,
  rank,
  rankedMatches,
  vectorOf,
} from '../records/full-text.js';
import { type RecordDeclaration, searchedFields } from '../records/record.js';
import {
  type RecordRegistration,
  Records,
} from '../records/records.service.js';

/** A hit of the global search: a record, as a result list shows it. */
export interface SearchHit {
  subject: string;
  id: string;
  title: string;
  /** Around the matches, the matches in <b>…</b>; null when the caller may not read the text. */
  snippet: string | null;
  /** How well it matches: 0 to 1. */
  score: number;
  /** Where to go: a path of the web app. */
  link: string | null;
  /** How the subject is named: one record and several. */
  subjectLabel: { singular: string; plural: string };
}

const SNIPPET = '__snippet_';

/**
 * The global search (GET /v1/search): every record registered
 * (modules/records) that declares searchable fields, asked at once, best
 * matches first across them. Field-level permissions: a field the caller
 * may read on no record, or on some only, is not matched (a hit would tell
 * where its text is hidden) and gives no snippet.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly records: Records,
    private readonly access: AccessService,
    private readonly txHost: TransactionHost<DatabaseTransactions>,
  ) {}

  async search(
    principal: Principal,
    q: string,
    { subject, limit }: { subject?: string; limit: number },
  ): Promise<SearchHit[]> {
    const sources = this.records
      .all()
      .filter(
        (record) =>
          searchedFields(record.declaration).length > 0 &&
          (subject === undefined || record.declaration.subject === subject),
      );
    const hits = (
      await Promise.all(
        sources.map((source) => this.searchOne(source, principal, q, limit)),
      )
    ).flat();
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  /** One record's matches the principal may read, best first. */
  private async searchOne(
    { declaration, feature }: RecordRegistration,
    principal: Principal,
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const { subject, fields } = declaration;
    const table = feature.table;
    // Long texts first (a body says more than a title), then the rest.
    const searchable = [...searchedFields(declaration)].sort(
      (a, b) =>
        Number(fields[b]!.kind === 'text') - Number(fields[a]!.kind === 'text'),
    );
    const [denied, conditional] = await Promise.all([
      this.access.deniedFields(principal, 'read', subject),
      this.access.conditionalFields(principal, 'read', subject),
    ]);
    const unmatchable = new Set([...denied, ...conditional]);
    const visible = searchable.filter((name) => !unmatchable.has(name));
    if (visible.length === 0) return [];
    // A vector of the fields they may read, made now (without the index).
    const vector =
      visible.length === searchable.length
        ? table.search!
        : vectorOf(visible.map((name) => table[name]!));
    const where = and(
      await this.access.sqlFilter(principal, subject, 'read', {
        deleted: false,
      }),
      matches(vector, q),
    );
    const score = rank(vector, q);
    const db = this.txHost.tx;
    const pg = table as unknown as PgTable;
    const rows = (await db
      // The whole row: the permission conditions (`mine`) read it.
      .select({
        ...getColumns(pg),
        score,
        ...Object.fromEntries(
          searchable.map((name) => [
            `${SNIPPET}${name}`,
            headline(table[name]!, q),
          ]),
        ),
      })
      .from(pg)
      // The best of the newest RANK_CAP matches: ranking reads every row it ranks.
      .where(and(where, await rankedMatches(db, pg, table.id, where)))
      .orderBy(desc(score), desc(table.id))
      .limit(limit)) as Record<string, unknown>[];
    const shown = await this.access.redactAll(principal, 'read', subject, rows);
    const subjectLabel = labelOf(declaration);
    return shown.map((row) => ({
      subject,
      id: row.id as string,
      title: titleOf(declaration, row),
      // Only a snippet of a field still shown after redaction, with a match.
      snippet:
        visible
          .filter((name) => name in row && row[name] != null)
          .map((name) => row[`${SNIPPET}${name}`] as string | null)
          .find((snippet) => snippet?.includes('<b>')) ?? null,
      score: Number(row.score),
      link: `/${declaration.path}/${row.id as string}`,
      subjectLabel,
    }));
  }
}

/** A hit's title: its first string field, else its id. */
function titleOf(declaration: RecordDeclaration, row: Record<string, unknown>) {
  const name = Object.keys(declaration.fields).find(
    (key) => declaration.fields[key]!.kind === 'string' && row[key] != null,
  );
  return name ? String(row[name]) : String(row.id);
}

/** The subject's names, from its declaration's noun (`test item`: Test item, Test items). */
function labelOf({ noun }: RecordDeclaration) {
  const singular = noun[0]!.toUpperCase() + noun.slice(1);
  return { singular, plural: `${singular}s` };
}
