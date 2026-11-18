import { Injectable } from '@nestjs/common';
import {
  InjectRecord,
  RecordExtension,
  type RecordChange,
  type RecordHooks,
} from '../records/record-extension.js';
import type { RecordDeclaration, RecordRow } from '../records/record.js';
import type { Principal } from '../../iam/auth/principal.js';
import { RevisionsService, snapshotOf } from './revisions.service.js';

/**
 * What revisions add to a record's writes, in their transaction: a
 * revision after a create (revision 1), an update (what changed; marked
 * `restoredFrom` when the write is a restore's) and a restore from the
 * recycle bin; the revisions of records that go for good go with them.
 */
@RecordExtension()
@Injectable()
export class RevisionsExtension implements RecordHooks {
  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly revisions: RevisionsService,
  ) {}

  async created({ row, by }: RecordChange) {
    await this.revisions.record(this.record.subject, row.id, {
      snapshot: snapshotOf(this.record, row),
      by,
    });
  }

  async updated({
    before,
    after,
    by,
    input,
  }: {
    before: RecordRow;
    after: RecordRow;
    by: Principal;
    input: Record<string, unknown>;
  }) {
    await this.revisions.record(this.record.subject, after.id, {
      snapshot: snapshotOf(this.record, after),
      before: snapshotOf(this.record, before),
      by,
      restoredFrom: this.revisions.restoredFrom(input),
    });
  }

  /** Out of the recycle bin: the same fields; only a record that kept no revision yet gets its first. */
  async restored({ row, by }: RecordChange) {
    await this.revisions.record(this.record.subject, row.id, {
      snapshot: snapshotOf(this.record, row),
      before: snapshotOf(this.record, row),
      by,
    });
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.revisions.forget(this.record.subject, ids);
  }
}
