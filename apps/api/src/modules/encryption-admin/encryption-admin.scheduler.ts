import { Injectable } from '@nestjs/common';
import { OnOneInstance, WithoutOverlapping } from '@nestjs/locks';
import { Cron } from '@nestjs/schedule';
import { EncryptionAdminService } from './encryption-admin.service.js';

/**
 * Every hour at :20, on one instance: queues the re-encryption of the rows
 * still on an old key, so a key added in front of DATA_ENCRYPTION_KEYS or
 * BLIND_INDEX_KEYS reaches every row within the hour after the deploy.
 */
@Injectable()
export class EncryptionAdminScheduler {
  constructor(private readonly admin: EncryptionAdminService) {}

  /** Returns how many jobs it queued. */
  @Cron('20 * * * *', { name: 'reencryption', timeZone: 'UTC' })
  @OnOneInstance({ key: 'encryption:reencryption' })
  @WithoutOverlapping()
  run() {
    return this.admin.schedule();
  }
}
