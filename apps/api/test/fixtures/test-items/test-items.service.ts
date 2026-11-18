import { Injectable } from '@nestjs/common';
import type { List, ListQuery } from '../../../src/core/http/list-query.js';
import type { Principal } from '../../../src/iam/auth/principal.js';
import { recordValues } from '../../../src/modules/records/record.js';
import {
  type CurrentCheck,
  type RecordLookup,
  RecordStore,
} from '../../../src/modules/records/record.store.js';
import { TEST_ITEM } from './test-item.record.js';
import type {
  CreateTestItemDto,
  TestItem,
  UpdateTestItemDto,
} from './test-item.schemas.js';

/**
 * Test items: the use cases. RecordStore does what the declaration decides
 * (owner, unit, recycle bin) and what every write causes in its
 * transaction (add-ons' hooks, the audit entry, the domain event). What
 * must hold for every write, whoever makes it (`words`), is the feature's
 * own hooks (test-item.logic.ts); what only its routes do goes here.
 */
@Injectable()
export class TestItemsService {
  constructor(private readonly records: RecordStore<TestItem>) {}

  /** `dto` goes along as `input`: the add-ons' hooks read their keys from it. */
  create(owner: Principal, dto: CreateTestItemDto) {
    return this.records.create(owner, recordValues(TEST_ITEM, dto), {
      input: dto,
    });
  }

  findOne(id: string, lookup?: RecordLookup) {
    return this.records.findOne(id, lookup);
  }

  findPage(user: Principal, list: List, query: ListQuery) {
    return this.records.findPage(user, list, query);
  }

  update(
    by: Principal,
    id: string,
    dto: UpdateTestItemDto,
    check?: CurrentCheck<TestItem>,
  ) {
    return this.records.update(by, id, recordValues(TEST_ITEM, dto), {
      check,
      input: dto,
    });
  }

  delete(by: Principal, id: string, check?: CurrentCheck<TestItem>) {
    return this.records.delete(by, id, { check });
  }
}
