import { InjectTransaction } from '@nestjs-cls/transactional';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, exists, isNull } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../../core/database/database.js';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import {
  headline,
  matches,
  rank,
  rankedMatches,
} from '../records/full-text.js';
import { Records } from '../records/records.service.js';
import {
  SearchSource,
  type SearchHit,
  type SearchSourceProvider,
} from '../search/search.source.js';
import { AttachmentTextQueue } from './attachments.queues.js';
import { attachments } from './attachments.tables.js';
import { attachmentTexts } from './attachments.texts.tables.js';

/**
 * Files in the global search (ATTACHMENT_TEXT_SEARCH): the attachments whose
 * extracted text matches, of the records the principal may read now (each
 * record type's read filter, the recycle bin left out), best match first, a
 * snippet of the text and a link to the record. Only the text of the file the
 * attachment has now (a replaced file's never matches), only clean files, and
 * never an issued document (`fields` set: its text is the record's, which the
 * record's own search matches under field-level permissions). Found by
 * `GET /v1/search` (`@SearchSource`). Hits have the shape of `SearchHit`
 * (subject `Attachment`, the attachment's id, its name as title).
 */
@SearchSource('Attachment')
@Injectable()
export class AttachmentSearch implements SearchSourceProvider {
  constructor(
    @InjectTransaction() private readonly db: Database,
    private readonly access: AccessService,
    private readonly records: Records,
    private readonly queue: AttachmentTextQueue,
  ) {}

  async search(
    principal: Principal,
    q: string,
    { limit }: { limit: number },
  ): Promise<SearchHit[]> {
    if (!this.queue.enabled) return [];
    const hits = await Promise.all(
      this.records.all().map((record) => this.of(record, principal, q, limit)),
    );
    return hits
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** The matching files of one record type. */
  private async of(
    { declaration, feature }: ReturnType<Records['all']>[number],
    principal: Principal,
    q: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const { subject } = declaration;
    const table = feature.table;
    // On attachment_texts alone, so the capped count and the ranking find the
    // matches by the GIN index; the record's read filter decides per match.
    const where = and(
      matches(attachmentTexts.search, q),
      exists(
        this.db
          .select({ id: attachments.id })
          .from(attachments)
          .innerJoin(
            table as unknown as PgTable,
            eq(table.id, attachments.recordId),
          )
          .where(
            and(
              eq(attachments.id, attachmentTexts.attachmentId),
              eq(attachments.key, attachmentTexts.key),
              eq(attachments.subject, subject),
              eq(attachments.scanStatus, 'clean'),
              eq(attachments.locked, false),
              isNull(attachments.fields),
              await this.access.sqlFilter(principal, subject, 'read', {
                deleted: false,
              }),
            ),
          ),
      ),
    );
    const score = rank(attachmentTexts.search, q);
    const rows = await this.db
      .select({
        id: attachments.id,
        name: attachments.name,
        recordId: attachments.recordId,
        score,
        snippet: headline(attachmentTexts.text, q),
      })
      .from(attachmentTexts)
      .innerJoin(attachments, eq(attachments.id, attachmentTexts.attachmentId))
      .where(
        and(
          where,
          await rankedMatches(
            this.db,
            attachmentTexts,
            attachmentTexts.id,
            where,
          ),
        ),
      )
      .orderBy(desc(score), desc(attachmentTexts.id))
      .limit(limit);
    return rows.map((row) => ({
      subject: 'Attachment',
      id: row.id,
      title: row.name,
      snippet: row.snippet.includes('<b>') ? row.snippet : null,
      score: Number(row.score),
      link: `/${declaration.path}/${row.recordId}`,
      subjectLabel: { singular: 'File', plural: 'Files' },
    }));
  }
}
