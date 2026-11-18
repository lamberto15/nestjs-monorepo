import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { i18nConfig } from '../../core/i18n/i18n.config.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { ApiClientsModule } from '../../iam/api-clients/api-clients.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { AttachmentsModule } from '../attachments/attachments.module.js';
import { BrandingModule } from '../branding/branding.module.js';
import { PeopleModule } from '../people/people.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import type { RecordDeclaration } from '../records/record.js';
import { RECORD } from '../records/record-extension.js';
import { RecordsModule } from '../records/records.module.js';
import { DocumentTemplates } from './document-templates.js';
import { documentsConfig } from './documents.config.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsProcessor } from './documents.processor.js';
import { DocumentsExtension, documentRoutes } from './documents.record.js';
import { DOCUMENTS, DocumentsService } from './documents.service.js';
import {
  type DocumentOptions,
  DocumentSourceRegistration,
  DocumentSources,
} from './documents.source.js';
import { gotenbergClient, PdfRenderer } from './pdf-renderer.js';
import { DocumentsPersonalData } from './documents.personal-data.js';

/**
 * PDF documents (README.md): a record's PDF rendered by Gotenberg on a
 * worker, stored on the private disk (modules/storage). A record issues
 * them with `DocumentsModule.forRecord(RECORD, { template })`. Needs the
 * core (database, tenancy, queues, redis, http client), StorageModule,
 * AuthModule and AccessModule.
 */
@Module({
  imports: [
    ConfigModule.forFeature(documentsConfig),
    ConfigModule.forFeature(i18nConfig),
    // Gotenberg, which renders the PDF (GOTENBERG_URL).
    gotenbergClient(),
    BullModule.registerQueue({
      name: DOCUMENTS,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    AccessModule,
    AttachmentsModule,
    BrandingModule,
    PeopleModule,
    RecordsModule,
    AuditModule,
    RealtimeModule,
    ApiClientsModule,
    DiscoveryModule,
  ],
  controllers: [DocumentsController],
  providers: [
    DocumentSources,
    DocumentTemplates,
    PdfRenderer,
    DocumentsService,
    DocumentsProcessor,
    DocumentsPersonalData,
  ],
  exports: [DocumentsService, PdfRenderer],
})
export class DocumentsModule {
  /**
   * Lets a record issue PDFs: the feature's own import. `template` names a
   * template of `dir` (default: a table of the record's fields).
   *
   * ```ts
   * imports: [DocumentsModule.forRecord(INVOICE, { template: 'invoice', dir })]
   * ```
   */
  static forRecord(
    record: RecordDeclaration,
    options: DocumentOptions = {},
  ): DynamicModule {
    return {
      module: DocumentRecordModule,
      imports: [
        DocumentsModule,
        RecordsModule,
        ConfigModule.forFeature(i18nConfig),
      ],
      controllers: [documentRoutes(record)],
      providers: [
        { provide: RECORD, useValue: record },
        {
          provide: DocumentSourceRegistration,
          useValue: new DocumentSourceRegistration(record, options),
        },
        DocumentsExtension,
      ],
    };
  }
}

/** The host of one `DocumentsModule.forRecord()` registration. */
@Module({})
class DocumentRecordModule {}
