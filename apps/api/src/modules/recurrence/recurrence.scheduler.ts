import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { RecurrenceService } from './recurrence.service.js';

/**
 * Every five minutes, on one instance: queues one job for each tenant that
 * has a recurring schedule due (the records are created by the job, in the
 * tenant, never here). Returns how many jobs it queued.
 */
@Injectable()
export class RecurrenceScheduler {
  constructor(private readonly recurrence: RecurrenceService) {}

  @Cron('*/5 * * * *', { name: 'record-schedules', timeZone: 'UTC' })
  @OnOneInstance({ key: 'record-schedules:queue' })
  @WithoutOverlapping()
  run() {
    return this.recurrence.queueDue();
  }
}
