import { type DynamicModule, Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { PeopleModule } from '../people/people.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RECORD } from '../records/record-extension.js';
import type { RecordDeclaration } from '../records/record.js';
import { RecordsModule } from '../records/records.module.js';
import { commentsController } from './comments.controller.js';
import { CommentsExtension } from './comments.extension.js';
import { COMMENT_NOTIFICATIONS } from './comments.notifications.js';
import { CommentsService } from './comments.service.js';
import { CommentsPersonalData } from './comments.personal-data.js';

/** The comments' notification types, declared once however many records take comments. */
@Module({
  imports: [NotificationsModule.forFeature(COMMENT_NOTIFICATIONS)],
})
class CommentsNotificationsModule {}

/** The person's comments for their export and erasure: one section however many records take comments. */
@Module({ providers: [CommentsPersonalData] })
class CommentsPersonalDataModule {}

/**
 * Comments on a record type (README.md): `CommentsModule.forRecord(NOTE)` in
 * the feature module's imports. Its routes, and what it adds to the record's
 * writes, come with it.
 */
@Module({})
export class CommentsModule {
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: CommentsModule,
      imports: [
        RecordsModule,
        AccessModule,
        AuditModule,
        RealtimeModule,
        PeopleModule,
        NotificationsModule,
        CommentsNotificationsModule,
        CommentsPersonalDataModule,
      ],
      controllers: [commentsController(record)],
      providers: [
        { provide: RECORD, useValue: record },
        CommentsService,
        CommentsExtension,
      ],
    };
  }
}
