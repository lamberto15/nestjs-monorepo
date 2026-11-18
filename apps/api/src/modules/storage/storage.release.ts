import { Injectable, Module } from '@nestjs/common';
import { StorageDisk } from '@nestjs/storage';
import {
  defineEvent,
  Events,
  OnDomainEvent,
} from '../../core/outbox/events.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { accountFileKey, tenantFileKey } from './storage.keys.js';

/**
 * Files nothing points at any more: the keys themselves, or every file under
 * a prefix (a tenant's `tenants/<id>/`, an account's `accounts/<id>/`).
 */
export const filesReleased = defineEvent<{
  keys?: string[];
  prefixes?: string[];
}>('storage.files-released');

/**
 * Deletes files once the transaction that let go of them commits. A row
 * deleted with its file deleted at once loses the file when a later step
 * rolls the row back; released here, the file goes after the commit (the
 * outbox), and stays when the transaction rolls back. Deleting is
 * idempotent: a missing key is no error, a prefix is listed again until
 * empty, so a redelivery or a retry after a failure repeats nothing harmful.
 */
@Injectable()
export class StoredFiles {
  constructor(
    private readonly events: Events,
    private readonly disk: StorageDisk,
  ) {}

  /** In the transaction that drops what names these files (throws outside one). */
  async release(keys: readonly string[]) {
    if (keys.length === 0) return;
    await this.events.publish(filesReleased, { keys: [...new Set(keys)] });
  }

  /** Every file of the tenant, in the transaction of its erase. */
  releaseTenant(tenantId: string) {
    return this.events.publish(filesReleased, {
      prefixes: [tenantFileKey(tenantId, '')],
    });
  }

  /** Every file of the account, in the transaction of its erase. */
  releaseAccount(userId: string) {
    return this.events.publish(filesReleased, {
      prefixes: [accountFileKey(userId, '')],
    });
  }

  /** After the commit, in the worker. A failure is retried by the outbox. */
  @OnDomainEvent(filesReleased, { consumer: 'storage.delete-released' })
  async deleteReleased({
    keys = [],
    prefixes = [],
  }: {
    keys?: string[];
    prefixes?: string[];
  }) {
    if (keys.length > 0) await this.disk.delete(keys);
    for (const prefix of prefixes) {
      // The first page each round: what was deleted is no longer listed.
      for (;;) {
        const { entries } = await this.disk.list({ prefix });
        if (entries.length === 0) break;
        await this.disk.delete(entries.map((entry) => entry.key));
      }
    }
  }
}

/**
 * `StoredFiles` for a module that deletes files with its rows. Apart from
 * StorageModule, which configures the disk: it uses whichever disk the app
 * (or a test) registered.
 */
@Module({
  imports: [SharedOutboxModule],
  providers: [StoredFiles],
  exports: [StoredFiles],
})
export class StoredFilesModule {}
