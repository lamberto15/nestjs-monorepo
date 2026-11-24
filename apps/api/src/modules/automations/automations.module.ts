import { type DynamicModule, Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { z } from 'zod';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import {
  aNoun,
  type RecordDeclaration,
  type RecordRow,
} from '../records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordExtension,
  type RecordHooks,
} from '../records/record-extension.js';
import { recordSchemas } from '../records/record.schemas.js';
import { RecordsModule } from '../records/records.module.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { AutomationActions } from './automation-actions.js';
import {
  NotifyAction,
  SetFieldAction,
  WebhookAction,
} from './automations.actions.js';
import { automationsConfig } from './automations.config.js';
import { AutomationsController } from './automations.controller.js';
import { automationMatched } from './automations.events.js';
import { AUTOMATION_NOTIFICATIONS } from './automations.notifications.js';
import { AUTOMATION_PERMISSIONS } from './automations.permissions.js';
import { AutomationRulePolicy } from './automations.policy.js';
import { AutomationRunRetentionJob } from './automations.retention.job.js';
import { AutomationRunner } from './automations.runner.js';
import {
  AUTOMATIONS_CAPABILITY,
  AutomationsService,
} from './automations.service.js';

/**
 * Tenant automation rules (README.md): the /automation-rules routes, the
 * runner (in the worker, through the outbox), the built-in actions
 * (setField, notify, webhook) and the discovery of the others
 * (`@AutomationAction()`). A feature whose records take rules imports
 * `AutomationsModule.forRecord(ITEM)`. Needs the core (database, tenancy,
 * outbox), AuthModule, AccessModule and NotificationsModule's needs.
 */
@Module({
  imports: [
    AccessModule.forFeature(AUTOMATION_PERMISSIONS),
    AuditModule,
    ConfigModule.forFeature(automationsConfig),
    DiscoveryModule,
    RecordsModule,
    NotificationsModule,
    NotificationsModule.forFeature(AUTOMATION_NOTIFICATIONS),
  ],
  controllers: [AutomationsController],
  providers: [
    AutomationActions,
    AutomationsService,
    AutomationRunner,
    AutomationRunRetentionJob,
    AutomationRulePolicy,
    SetFieldAction,
    NotifyAction,
    WebhookAction,
  ],
  exports: [AutomationRunner],
})
export class AutomationsModule {
  /**
   * Rules may be about this record: its creates and updates start the
   * subject's active rules (decided in the write's transaction, run after
   * the commit), and `<item>.automation-matched` is a webhook API clients
   * may subscribe to (the `webhook` action).
   *
   * ```ts
   * imports: [AutomationsModule.forRecord(INVOICE)]
   * ```
   */
  static forRecord(record: RecordDeclaration): DynamicModule {
    @RecordExtension()
    @Injectable()
    class AutomationTrigger implements RecordHooks {
      readonly capability = AUTOMATIONS_CAPABILITY;

      constructor(
        @InjectRecord() readonly record: RecordDeclaration,
        private readonly runner: AutomationRunner,
      ) {}

      async created({ row }: { row: RecordRow }) {
        await this.runner.changed(this.record, 'created', row);
      }

      async updated({
        before,
        after,
      }: {
        before: RecordRow;
        after: RecordRow;
      }) {
        await this.runner.changed(this.record, 'updated', after, before);
      }
    }
    Object.defineProperty(AutomationTrigger, 'name', {
      value: `${record.subject}AutomationTrigger`,
    });
    return {
      module: AutomationsRecordModule,
      imports: [
        AutomationsModule,
        WebhooksModule.forFeature([
          {
            event: automationMatched(record),
            subject: record.subject,
            description: `An automation rule matched ${aNoun(record)}.`,
            data: recordSchemas(record).response.extend({
              automationRule: z.object({ id: z.uuid(), name: z.string() }),
            }),
          },
        ]),
      ],
      providers: [{ provide: RECORD, useValue: record }, AutomationTrigger],
    };
  }
}

/** The host of one `AutomationsModule.forRecord()`. */
@Module({})
class AutomationsRecordModule {}
