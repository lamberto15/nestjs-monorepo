import { Injectable } from '@nestjs/common';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';

/** Says in the list's description that the record takes merges (`capabilities.merge`); it adds nothing to its writes. */
@RecordExtension()
@Injectable()
export class MergeExtension implements RecordHooks {
  readonly capability = 'merge';

  constructor(@InjectRecord() readonly record: RecordDeclaration) {}
}
