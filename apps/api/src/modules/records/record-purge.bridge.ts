import { Injectable } from '@nestjs/common';
import { RecordPurge, type RecordPurger } from '../retention/record-purge.js';
import { RECYCLE_BIN_PURGE } from './recycle-bin.job.js';
import { Records } from './records.service.js';

/**
 * Records purged by a retention rule (modules/retention, `RecordPurges.forget()`
 * in its transaction) go as the recycle bin's do: the references to them
 * emptied and the add-ons' `purged` hooks called. Add-ons of records
 * implement `RecordHooks.purged`, never `@RecordPurge()` themselves.
 * Without RetentionModule in the app nothing calls it.
 */
@RecordPurge()
@Injectable()
export class RecordPurgeBridge implements RecordPurger {
  constructor(private readonly records: Records) {}

  async forget(subject: string, ids: readonly string[]) {
    await this.records.find(subject)?.store.forget(RECYCLE_BIN_PURGE, ids);
  }
}
