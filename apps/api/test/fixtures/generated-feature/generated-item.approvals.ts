import { Injectable } from '@nestjs/common';
import {
  ApprovalEffect,
  type ApprovalEffectHandler,
} from '../../../src/modules/approvals/approvals.registry.js';

/**
 * What `publish` does once it is applied: at once while its approval is
 * off (the setting `generatedItems.publishApproval`), else once approved.
 */
@ApprovalEffect({ subject: 'GeneratedItem', action: 'publish' })
@Injectable()
export class PublishGeneratedItem implements ApprovalEffectHandler {
  apply(): Promise<void> {
    // Business logic: what "Publish a generated item" does to the record, from
    // `apply(applied: ApprovalApplied)` (`applied.id`, `applied.actor`), through its
    // store: `records.of('GeneratedItem').store.update(applied.actor, applied.id, { … })`
    // (Records, modules/records). It may run more than once: make it idempotent.
    return Promise.resolve();
  }
}
