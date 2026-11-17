import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LocksModule } from '@nestjs/locks';
import { ScheduleModule } from '@nestjs/schedule';
import { queuesConfig, runsWorkers } from '../queues/queues.config.js';
import { locksConfig } from './locks.config.js';
import { DrizzleLockStore } from './locks.store.js';

/**
 * Distributed locks (@nestjs/locks, kept in PostgreSQL by DrizzleLockStore)
 * and the scheduler (@nestjs/schedule). A job is a method with `@Cron()` and
 * `@OnOneInstance({ key })`: the instances share the schedule and only one
 * runs each tick. Jobs fire only where the process runs workers (APP_ROLE
 * `worker` or `all`) and SCHEDULER is on; the SchedulerRegistry exists
 * everywhere.
 */
@Module({
  imports: [
    LocksModule.forRoot(),
    ScheduleModule.forRootAsync({
      imports: [
        ConfigModule.forFeature(queuesConfig),
        ConfigModule.forFeature(locksConfig),
      ],
      inject: [queuesConfig.KEY, locksConfig.KEY],
      useFactory: (
        queues: ReturnType<typeof queuesConfig>,
        locks: ReturnType<typeof locksConfig>,
      ) => {
        const on = locks.scheduler && runsWorkers(queues.role);
        return { cronJobs: on, intervals: on, timeouts: on };
      },
    }),
  ],
  providers: [DrizzleLockStore],
})
export class SharedLocksModule {}
