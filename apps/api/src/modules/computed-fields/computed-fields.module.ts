import { type DynamicModule, Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import type { RecordDeclaration } from '../records/record.js';
import { RECORD } from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import type { ComputedDeclaration } from './computed-fields.js';
import {
  COMPUTED,
  ComputedFieldsExtension,
} from './computed-fields.extension.js';

/**
 * Computed fields (README.md): a record's values derived from its fields
 * by an expression, shown on read. A feature imports
 * `ComputedFieldsModule.forRecord(INVOICE, INVOICE_COMPUTED)`.
 */
@Module({})
export class ComputedFieldsModule {
  static forRecord(
    record: RecordDeclaration,
    computed: ComputedDeclaration,
  ): DynamicModule {
    if (computed.record !== record) {
      throw new Error(
        `ComputedFieldsModule.forRecord(${record.subject}): its computed fields are ${computed.record.subject}'s.`,
      );
    }
    return {
      module: ComputedFieldsModule,
      imports: [AccessModule, RecordsModule],
      providers: [
        { provide: RECORD, useValue: record },
        { provide: COMPUTED, useValue: computed },
        ComputedFieldsExtension,
      ],
    };
  }
}
