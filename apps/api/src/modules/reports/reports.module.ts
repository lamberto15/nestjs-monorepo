import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from '../../core/mail/mail.module.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { DataTransferModule } from '../data-transfer/data-transfer.module.js';
import { reportsConfig } from './reports.config.js';
import { ReportsController } from './reports.controller.js';
import { ReportFailedMail, ReportReadyMail } from './reports.mails.js';
import { REPORTS_PERMISSIONS } from './reports.permissions.js';
import { ReportsRunner } from './reports.runner.js';
import { ReportsService } from './reports.service.js';
import { ReportsPersonalData } from './reports.personal-data.js';

/**
 * Scheduled reports (README.md): the routes under /v1/reports, the hourly
 * runner and the mails of a run. The exports are data-transfer's: a record
 * is reportable when it is exportable (`DataTransferModule.forRecord()`).
 * Needs what DataTransferModule needs, MailModule's queue, SharedLocksModule
 * and ScheduleModule (for the cron).
 */
@Module({
  imports: [
    AccessModule.forFeature(REPORTS_PERMISSIONS),
    AuditModule,
    DataTransferModule,
    MailModule,
    ConfigModule.forFeature(reportsConfig),
  ],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportsRunner,
    ReportReadyMail,
    ReportFailedMail,
    ReportsPersonalData,
  ],
})
export class ReportsModule {}
