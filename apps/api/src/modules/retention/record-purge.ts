import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

/**
 * What else goes when records are deleted for good: a module's data about
 * them (comments, tags, watchers), kept in tables of its own without a
 * foreign key to the record. A provider that holds such data implements
 * this and is marked `@RecordPurge()` (every subject) or
 * `@RecordPurge({ subject: 'Note' })`; whatever deletes records for good
 * (the retention job, the recycle bin's purge) calls `RecordPurges.forget()`
 * in its transaction, before deleting the rows, so the listeners' queries join it.
 */
export interface RecordPurger {
  forget(subject: string, recordIds: readonly string[]): Promise<void>;
}

/** Marks a `RecordPurger`; `subject` limits it to the records of that subject. */
export const RecordPurge = DiscoveryService.createDecorator<{
  subject?: string;
}>();

@Injectable()
export class RecordPurges implements OnModuleInit {
  private purgers: { purger: RecordPurger; subject?: string }[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit() {
    this.purgers = this.discovery
      .getProviders({ metadataKey: RecordPurge.KEY })
      .flatMap((wrapper) => {
        const options = this.discovery.getMetadataByDecorator(
          RecordPurge,
          wrapper,
        );
        return wrapper.instance
          ? [
              {
                purger: wrapper.instance as RecordPurger,
                subject: options?.subject,
              },
            ]
          : [];
      });
  }

  /** Removes what refers to these records of `subject`. */
  async forget(subject: string, recordIds: readonly string[]) {
    for (const entry of this.purgers) {
      if (!entry.subject || entry.subject === subject) {
        await entry.purger.forget(subject, recordIds);
      }
    }
  }
}
