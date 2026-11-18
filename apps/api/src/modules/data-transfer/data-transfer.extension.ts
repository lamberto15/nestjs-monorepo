import { Injectable } from '@nestjs/common';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';

/**
 * What `DataTransferModule.forRecord()` adds to a record: its `transfer`
 * capability in GET /v1/lists/{subject} (how a list page knows it can
 * export and import), and the mark RecordTransfers finds it by. No hook:
 * an export reads the list as it is, and an import writes through the
 * record's store, whose hooks run as for any write.
 */
@RecordExtension()
@Injectable()
export class TransferExtension implements RecordHooks {
  readonly capability = 'transfer';

  constructor(@InjectRecord() readonly record: RecordDeclaration) {}
}
