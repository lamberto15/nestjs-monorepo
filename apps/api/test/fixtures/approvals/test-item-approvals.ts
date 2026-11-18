import { Injectable, Module } from '@nestjs/common';
import {
  type ApprovalApplied,
  ApprovalEffect,
  type ApprovalEffectHandler,
} from '../../../src/modules/approvals/approvals.registry.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { Records } from '../../../src/modules/records/records.service.js';

/**
 * The approvals e2e's actions on test items: `publish` sets the item done,
 * through the record's guarded write (the approved effect passes its own
 * lock). `failing` counts how many attempts in a row throw.
 */
@ApprovalEffect({ subject: 'TestItem', action: 'publish' })
@Injectable()
export class PublishTestItem implements ApprovalEffectHandler {
  static failing = 0;
  static applied: ApprovalApplied[] = [];

  constructor(private readonly records: Records) {}

  async apply(applied: ApprovalApplied) {
    if (PublishTestItem.failing > 0) {
      PublishTestItem.failing--;
      throw new Error('The effect failed.');
    }
    PublishTestItem.applied.push(applied);
    await this.records
      .of('TestItem')
      .store.update(applied.actor, applied.id, { status: 'done' });
  }
}

/** `archive`: switched on by its flag only; it changes nothing but is counted. */
@ApprovalEffect({ subject: 'TestItem', action: 'archive' })
@Injectable()
export class ArchiveTestItem implements ApprovalEffectHandler {
  static applied: ApprovalApplied[] = [];

  async apply(applied: ApprovalApplied) {
    ArchiveTestItem.applied.push(applied);
  }
}

@Module({
  imports: [RecordsModule],
  providers: [PublishTestItem, ArchiveTestItem],
})
export class TestItemApprovalEffects {}
