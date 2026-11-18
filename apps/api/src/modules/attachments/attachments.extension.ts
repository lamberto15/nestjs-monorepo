import { Injectable } from '@nestjs/common';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import { AttachmentsService } from './attachments.service.js';

/**
 * What attachments add to a record that takes them: `capabilities.attachments`
 * and `attachmentLimits` in its list's description, and its files gone with
 * it when it is deleted for good (a delete without recycle bin, the bin's
 * purge, a retention rule). A record in the recycle bin keeps its files,
 * hidden with it until it is restored.
 */
@RecordExtension()
@Injectable()
export class AttachmentsExtension implements RecordHooks {
  readonly capability = 'attachments';

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly attachments: AttachmentsService,
  ) {}

  async purged({ ids }: { ids: readonly string[] }) {
    await this.attachments.forget(this.record.subject, ids);
  }

  async merged({ from, to }: { from: RecordRow; to: RecordRow }) {
    await this.attachments.merge(this.record.subject, from.id, to.id);
  }

  /** What a client checks a file against before it sends it: the very limits the upload refuses by. */
  async describe() {
    return { attachmentLimits: this.attachments.limits };
  }
}
