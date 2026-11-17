import { Module } from '@nestjs/common';
import { AccessModule } from '../../iam/access/access.module.js';
import { AuditModule } from '../../iam/audit/audit.module.js';
import { CalendarsController } from './calendars.controller.js';
import { CALENDAR_PERMISSIONS } from './calendars.permissions.js';
import { CalendarPolicy } from './calendars.policy.js';
import { CalendarsService } from './calendars.service.js';

/**
 * Business calendars (README.md): the routes under /calendars and
 * CalendarsService, whose `row()` and `addWorkingMinutes()` other modules
 * call for deadline math. Needs AuthModule (global), the tenancy and
 * database modules.
 */
@Module({
  imports: [AccessModule.forFeature(CALENDAR_PERMISSIONS), AuditModule],
  controllers: [CalendarsController],
  providers: [CalendarsService, CalendarPolicy],
  exports: [CalendarsService],
})
export class CalendarsModule {}
