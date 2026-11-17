import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { RetentionRules } from './retention.rules.js';
import { RetentionService } from './retention.service.js';

/**
 * Every night at 04:10 UTC, on one instance: queues the retention work of
 * every tenant's enabled rules (RetentionService.schedule()). The deletions
 * themselves run on the queue, never here. Nothing to do (and no query)
 * while no rule is declared.
 */
@Injectable()
export class RetentionScheduler {
  constructor(
    private readonly retention: RetentionService,
    private readonly rules: RetentionRules,
  ) {}

  /** Returns how many jobs it queued. */
  @Cron('10 4 * * *', { name: 'retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'retention:schedule' })
  @WithoutOverlapping()
  run() {
    if (this.rules.all().length === 0) {
      return Promise.resolve(0);
    }
    return this.retention.schedule();
  }
}
