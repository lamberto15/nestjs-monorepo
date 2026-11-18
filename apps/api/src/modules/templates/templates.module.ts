import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { OrganizationModule } from '../../iam/organization/organization.module.js';
import type { RecordDeclaration } from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { TemplatesController } from './templates.controller.js';
import { TEMPLATE_PERMISSIONS } from './templates.permissions.js';
import { TEMPLATES_CAPABILITY, TemplatesService } from './templates.service.js';
import { TemplatesPersonalData } from './templates.personal-data.js';

/**
 * What a record that takes templates tells the engine: its list
 * description says `capabilities.templates`. TemplatesService finds the
 * records by it.
 */
@RecordExtension()
@Injectable()
class TemplatesExtension implements RecordHooks {
  readonly capability = TEMPLATES_CAPABILITY;

  constructor(@InjectRecord() readonly record: RecordDeclaration) {}
}

/** The `/v1/templates` routes (README.md); records opt in with `forRecord()`. */
@Module({
  imports: [
    AccessModule.forFeature(TEMPLATE_PERMISSIONS),
    AuditModule,
    OrganizationModule,
    RecordsModule,
  ],
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplatesPersonalData],
})
export class TemplatesModule {
  /**
   * Opts a record in: its create fields may be saved as templates. Imports
   * TemplatesModule, so one import in the feature serves the routes too.
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: TemplatedRecordModule,
      imports: [TemplatesModule, RecordsModule],
      providers: [{ provide: RECORD, useValue: record }, TemplatesExtension],
    };
  }
}

/** The host of one `TemplatesModule.forRecord()`. */
@Module({})
class TemplatedRecordModule {}
