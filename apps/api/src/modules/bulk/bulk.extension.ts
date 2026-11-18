import { Injectable } from '@nestjs/common';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';

/**
 * Marks a record as taking bulk operations (`BulkModule.forRecord()`):
 * BulkService acts only on records that have it, and the list's description
 * says so (`capabilities.bulk`). It adds nothing to the record's writes: a
 * bulk run goes through the record's store, as its routes do.
 */
@RecordExtension()
@Injectable()
export class BulkExtension implements RecordHooks {
  readonly capability = 'bulk';

  constructor(@InjectRecord() readonly record: RecordDeclaration) {}
}
