import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { TagsModule } from '../../../src/modules/tags/tags.module.js';
import { CommentsModule } from '../../../src/modules/comments/comments.module.js';
import { AttachmentsModule } from '../../../src/modules/attachments/attachments.module.js';
import { RevisionsModule } from '../../../src/modules/revisions/revisions.module.js';
import { FavoritesModule } from '../../../src/modules/favorites/favorites.module.js';
import { RecentsModule } from '../../../src/modules/recents/recents.module.js';
import { TemplatesModule } from '../../../src/modules/templates/templates.module.js';
import { ChoicesModule } from '../../../src/modules/choices/choices.module.js';
import {
  GENERATED_ITEM_CHOICES,
  GeneratedItemChoices,
} from './generated-item.choices.js';
import { CustomFieldsModule } from '../../../src/modules/custom-fields/custom-fields.module.js';
import { ComputedFieldsModule } from '../../../src/modules/computed-fields/computed-fields.module.js';
import { GENERATED_ITEM_COMPUTED } from './generated-item.computed.js';
import { ApprovalsModule } from '../../../src/modules/approvals/approvals.module.js';
import { PublishGeneratedItem } from './generated-item.approvals.js';
import { AcknowledgmentsModule } from '../../../src/modules/acknowledgments/acknowledgments.module.js';
import { BulkModule } from '../../../src/modules/bulk/bulk.module.js';
import { MergeModule } from '../../../src/modules/merge/merge.module.js';
import { DataTransferModule } from '../../../src/modules/data-transfer/data-transfer.module.js';
import { DataQualityModule } from '../../../src/modules/data-quality/data-quality.module.js';
import { SharesModule } from '../../../src/modules/shares/shares.module.js';
import { DocumentsModule } from '../../../src/modules/documents/documents.module.js';
import { AiModule } from '../../../src/modules/ai/ai.module.js';
import { AutomationsModule } from '../../../src/modules/automations/automations.module.js';
import { SequencesModule } from '../../../src/modules/sequences/sequences.module.js';
import { WebhooksModule } from '../../../src/modules/webhooks/webhooks.module.js';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module.js';
import { RecurrenceModule } from '../../../src/modules/recurrence/recurrence.module.js';
import { RetentionModule } from '../../../src/modules/retention/retention.module.js';
import { generatedItems } from './generated-items.tables.js';
import { McpModule } from '../../../src/modules/mcp/mcp.module.js';
import { GENERATED_ITEM_LIST } from './generated-item.list.js';
import { GENERATED_ITEM_PERMISSIONS } from './generated-item.permissions.js';
import { GeneratedItemPolicy } from './generated-item.policy.js';
import { GENERATED_ITEM } from './generated-item.record.js';
import { GENERATED_ITEM_SCHEMAS } from './generated-item.schemas.js';
import { GeneratedItemsController } from './generated-items.controller.js';
import { GeneratedItemsService } from './generated-items.service.js';

/**
 * Generated items: their permissions, their record (store, presenter,
 * restore route, registration), the routes, and each add-on one
 * import (modules/records/README.md, "Writing an add-on").
 */
@Module({
  imports: [
    AccessModule.forFeature(GENERATED_ITEM_PERMISSIONS),
    RecordsModule.forFeature(GENERATED_ITEM, {
      table: generatedItems,
      list: GENERATED_ITEM_LIST,
      schemas: GENERATED_ITEM_SCHEMAS,
      policy: GeneratedItemPolicy,
    }),
    TagsModule.forRecord(GENERATED_ITEM),
    CommentsModule.forRecord(GENERATED_ITEM),
    AttachmentsModule.forRecord(GENERATED_ITEM),
    RevisionsModule.forRecord(GENERATED_ITEM),
    FavoritesModule.forRecord(GENERATED_ITEM),
    RecentsModule.forRecord(GENERATED_ITEM),
    TemplatesModule.forRecord(GENERATED_ITEM),
    ChoicesModule.forRecord(GENERATED_ITEM, GENERATED_ITEM_CHOICES),
    CustomFieldsModule.forRecord(GENERATED_ITEM),
    ComputedFieldsModule.forRecord(GENERATED_ITEM, GENERATED_ITEM_COMPUTED),
    ApprovalsModule.forRecord(GENERATED_ITEM, {
      publish: { label: 'Publish a generated item' },
    }),
    AcknowledgmentsModule.forRecord(GENERATED_ITEM),
    BulkModule.forRecord(GENERATED_ITEM),
    MergeModule.forRecord(GENERATED_ITEM),
    DataTransferModule.forRecord(GENERATED_ITEM),
    // Business logic: its checks (recommended, duplicates, rules: modules/data-quality/README.md).
    DataQualityModule.forRecord(GENERATED_ITEM, { recommended: ['body'] }),
    SharesModule.forRecord(GENERATED_ITEM),
    DocumentsModule.forRecord(GENERATED_ITEM, {
      template: 'generated-item',
      dir: join(import.meta.dirname, 'templates'),
    }),
    AiModule.forRecord(GENERATED_ITEM),
    AutomationsModule.forRecord(GENERATED_ITEM),
    SequencesModule.forRecord(GENERATED_ITEM),
    WebhooksModule.forRecord(GENERATED_ITEM),
    NotificationsModule.forRecord(GENERATED_ITEM),
    RecurrenceModule.forRecord(GENERATED_ITEM),
    // Business logic: how long its records are kept by default (off until a tenant turns the rule on).
    RetentionModule.forRecord(GENERATED_ITEM, generatedItems, {
      defaultDays: 730,
      minDays: 30,
    }),
    McpModule.forRecord(GENERATED_ITEM),
  ],
  controllers: [GeneratedItemsController],
  providers: [
    GeneratedItemsService,
    GeneratedItemPolicy,
    GeneratedItemChoices,
    PublishGeneratedItem,
  ],
})
export class GeneratedItemsModule {}
