import { Injectable } from '@nestjs/common';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import { CommentsService } from './comments.service.js';

/**
 * What comments add to a record that takes them: `capabilities.comments` in
 * its list's description, and its comments gone with it when it is deleted
 * for good (a delete without recycle bin, the bin's purge, a retention rule).
 */
@RecordExtension()
@Injectable()
export class CommentsExtension implements RecordHooks {
  readonly capability = 'comments';

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly comments: CommentsService,
  ) {}

  async purged({ ids }: { ids: readonly string[] }) {
    await this.comments.forget(ids);
  }

  async merged({ from, to }: { from: RecordRow; to: RecordRow }) {
    await this.comments.merge(from.id, to.id);
  }
}
