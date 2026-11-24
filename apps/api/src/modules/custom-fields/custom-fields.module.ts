import { type DynamicModule, Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import type { RecordDeclaration } from '../records/record.js';
import { RECORD } from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { CustomFieldsController } from './custom-fields.controller.js';
import { CustomFieldsExtension } from './custom-fields.extension.js';
import { CUSTOM_FIELD_PERMISSIONS } from './custom-fields.permissions.js';
import { CustomFieldPolicy } from './custom-fields.policy.js';
import { CustomFieldsTransfer } from './custom-fields.transfer.js';
import { CustomFieldsRepository } from './custom-fields.repository.js';
import { CustomFieldsService } from './custom-fields.service.js';
import { CustomValuesService } from './custom-values.service.js';

/**
 * Custom fields (README.md): the definitions API (`/v1/custom-fields`)
 * and the values records hold. A record takes them with
 * `CustomFieldsModule.forRecord(INVOICE)` in its feature module's imports;
 * the definitions API comes with the first one.
 */
@Module({
  imports: [
    AccessModule.forFeature(CUSTOM_FIELD_PERMISSIONS),
    AuditModule,
    RecordsModule,
  ],
  controllers: [CustomFieldsController],
  // CustomFieldsTransfer: the `custom.<key>` columns of exports and imports (modules/data-transfer).
  providers: [
    CustomFieldsService,
    CustomFieldsRepository,
    CustomValuesService,
    CustomFieldPolicy,
    CustomFieldsTransfer,
  ],
  exports: [CustomFieldsService, CustomValuesService],
})
export class CustomFieldsModule {
  /**
   * Custom fields on a record: its bodies and responses take `custom`
   * (`recordSchemas(INVOICE, { body: CUSTOM_FIELDS_BODY, response: CUSTOM_FIELDS_RESPONSE })`).
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: CustomFieldsRecordModule,
      imports: [CustomFieldsModule, RecordsModule],
      providers: [{ provide: RECORD, useValue: record }, CustomFieldsExtension],
    };
  }
}

/** The host of one record's custom fields. */
@Module({})
class CustomFieldsRecordModule {}
