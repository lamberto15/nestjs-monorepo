import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { OutboxDeadLetters, OutboxInbox } from '@nestjs/outbox';
import { Cron } from '@nestjs/schedule';
import { outboxConfig } from './outbox.config.js';

/**
 * Deletes outbox dead letters older than OUTBOX_DEAD_LETTER_RETENTION_DAYS
 * and consumers' inbox records older than OUTBOX_INBOX_RETENTION_DAYS, every
 * night at 04:20 UTC, on one instance. The package deletes
 * (`OutboxDeadLetters.purge()`, `OutboxInbox.prune()`) but never ages either
 * table out itself. Its tables are global, one rule for every tenant.
 */
@Injectable()
export class OutboxRetentionJob {
  private readonly logger = new Logger('Outbox');

  constructor(
    @Inject(outboxConfig.KEY)
    private readonly config: ConfigType<typeof outboxConfig>,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly inbox: OutboxInbox,
  ) {}

  /** Returns how many dead letters and inbox records were deleted. */
  @Cron('20 4 * * *', { name: 'outbox-retention', timeZone: 'UTC' })
  @OnOneInstance({ key: 'outbox:retention' })
  @WithoutOverlapping()
  async run(now = new Date()) {
    const { deadLetterDays, inboxDays } = this.config;
    const failedBefore = new Date(now.getTime() - deadLetterDays * 86_400_000);
    const deadLetters = await this.deadLetters.purge({ failedBefore });
    const inbox = await this.inbox.prune(`${inboxDays}d`);
    this.logger.log(
      `Old outbox records deleted: ${deadLetters} dead letters, ${inbox} inbox records.`,
    );
    return { deadLetters, inbox };
  }
}
