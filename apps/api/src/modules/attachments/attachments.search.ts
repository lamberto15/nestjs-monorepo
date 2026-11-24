import { Injectable } from '@nestjs/common';
import { AccessService } from '../../iam/access/access.service.js';
import type { Principal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import {
  SearchSource,
  type SearchHit,
  type SearchSourceProvider,
} from '../search/search.source.js';
import { AttachmentTextQueue } from './attachments.queues.js';
import { AttachmentsRepository } from './attachments.repository.js';

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
    private readonly repository: AttachmentsRepository,
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
    const rows = await this.repository.searchTexts(
      feature.table,
      subject,
      await this.access.sqlFilter(principal, subject, 'read', {
        deleted: false,
      }),
      q,
      limit,
    );
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
