import { BullModule } from '@nestjs/bullmq';
import { type DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { DEFAULT_JOB_OPTIONS } from '../../core/queues/queues.js';
import { ImagesModule } from '../images/images.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { QuotasModule } from '../quotas/quotas.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RECORD } from '../records/record-extension.js';
import type { RecordDeclaration } from '../records/record.js';
import { RecordsModule } from '../records/records.module.js';
import { storageConfig } from '../storage/storage.config.js';
import { StoredFilesModule } from '../storage/storage.release.js';
import { attachmentsConfig } from './attachments.config.js';
import {
  AttachmentsController,
  recordAttachmentsController,
} from './attachments.controller.js';
import { AttachmentsExtension } from './attachments.extension.js';
import { TextExtractor } from './attachments.extractor.js';
import { AttachmentImagesService } from './attachments.images.js';
import {
  AttachmentImagesProcessor,
  AttachmentRetryJob,
  AttachmentScanProcessor,
} from './attachments.jobs.js';
import { ATTACHMENT_NOTIFICATIONS } from './attachments.notifications.js';
import { ATTACHMENT_PERMISSIONS } from './attachments.permissions.js';
import { STORAGE_BYTES } from './attachments.quota.js';
import {
  ATTACHMENT_IMAGES,
  ATTACHMENT_SCAN,
  ATTACHMENT_TEXT,
  AttachmentImagesQueue,
  AttachmentScanQueue,
  AttachmentTextQueue,
} from './attachments.queues.js';
import { AttachmentScanService } from './attachments.scan.js';
import { malwareScanner, MalwareScanner } from './attachments.scanner.js';
import { PresignedUploadsFeature } from './attachments.feature.js';
import { AttachmentSearch } from './attachments.search.js';
import { AttachmentsRepository } from './attachments.repository.js';
import { AttachmentsService } from './attachments.service.js';
import { AttachmentSweepJob } from './attachments.sweep.js';
import {
  AttachmentTextProcessor,
  AttachmentTextRetryJob,
  AttachmentTextService,
} from './attachments.text.js';
import { AttachmentUploadsService } from './attachments.uploads.js';
import { AttachmentVersionsService } from './attachments.versions.js';
import { AttachmentsPersonalData } from './attachments.personal-data.js';

/**
 * The attachments' machinery, once however many record types take files:
 * the `/v1/attachments/{id}` routes, the storage quota, the malware scan and
 * the image processing on their queues, and the retry job. Needs
 * QueuesModule, StorageModule, MetricsModule and the modules it imports.
 * A record type opts in with `AttachmentsModule.forRecord(NOTE)`.
 */
@Module({
  imports: [
    ConfigModule.forFeature(attachmentsConfig),
    // STORAGE_DRIVER: signed-URL uploads are offered with s3 only.
    ConfigModule.forFeature(storageConfig),
    AccessModule.forFeature(ATTACHMENT_PERMISSIONS),
    AuditModule,
    HoldsModule,
    ImagesModule,
    NotificationsModule,
    NotificationsModule.forFeature(ATTACHMENT_NOTIFICATIONS),
    QuotasModule.forFeature(STORAGE_BYTES),
    RealtimeModule,
    RecordsModule,
    // StoredFiles: a purged record's files go after the commit.
    StoredFilesModule,
    BullModule.registerQueue({
      name: ATTACHMENT_SCAN,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    BullModule.registerQueue({
      name: ATTACHMENT_IMAGES,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
    BullModule.registerQueue({
      name: ATTACHMENT_TEXT,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    }),
  ],
  controllers: [AttachmentsController],
  providers: [
    {
      provide: MalwareScanner,
      inject: [attachmentsConfig.KEY],
      useFactory: (config: ConfigType<typeof attachmentsConfig>) =>
        malwareScanner(config),
    },
    {
      provide: TextExtractor,
      inject: [attachmentsConfig.KEY],
      useFactory: (config: ConfigType<typeof attachmentsConfig>) =>
        new TextExtractor({
          maxBytes: config.textMaxBytes,
          timeoutMs: config.textTimeoutMs,
        }),
    },
    AttachmentsService,
    AttachmentsRepository,
    AttachmentVersionsService,
    AttachmentUploadsService,
    AttachmentScanQueue,
    AttachmentImagesQueue,
    AttachmentTextQueue,
    AttachmentTextService,
    AttachmentTextProcessor,
    AttachmentTextRetryJob,
    AttachmentSweepJob,
    AttachmentSearch,
    PresignedUploadsFeature,
    AttachmentScanService,
    AttachmentImagesService,
    AttachmentScanProcessor,
    AttachmentImagesProcessor,
    AttachmentRetryJob,
    AttachmentsPersonalData,
  ],
  exports: [
    AttachmentsService,
    AttachmentVersionsService,
    AttachmentUploadsService,
    AttachmentSearch,
    MalwareScanner,
  ],
})
export class AttachmentsModule {
  /** Files on a record type: `AttachmentsModule.forRecord(NOTE)` in the feature module's imports. */
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: AttachmentsRecordModule,
      imports: [
        ConfigModule.forFeature(attachmentsConfig),
        RecordsModule,
        AttachmentsModule,
      ],
      controllers: [recordAttachmentsController(record)],
      providers: [{ provide: RECORD, useValue: record }, AttachmentsExtension],
    };
  }
}

/** The host of one `AttachmentsModule.forRecord()`. */
@Module({})
class AttachmentsRecordModule {}
