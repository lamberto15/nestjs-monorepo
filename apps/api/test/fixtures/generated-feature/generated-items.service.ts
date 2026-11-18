import { Injectable } from '@nestjs/common';
import type { List, ListQuery } from '../../../src/core/http/list-query.js';
import type { Principal } from '../../../src/iam/auth/principal.js';
import { recordValues } from '../../../src/modules/records/record.js';
import {
  type CurrentCheck,
  type RecordLookup,
  RecordStore,
} from '../../../src/modules/records/record.store.js';
import { GENERATED_ITEM } from './generated-item.record.js';
import type {
  CreateGeneratedItemDto,
  GeneratedItem,
  UpdateGeneratedItemDto,
} from './generated-item.schemas.js';

/**
 * Generated items: the use cases. RecordStore does what the declaration decides
 * (owner, unit, recycle bin) and what every write causes in its transaction
 * (the add-ons' hooks, the audit entry, the domain event). Business logic
 * goes where the comments say so. Logic that must hold for every write,
 * whoever makes it (bulk, imports, automations), is a `@RecordExtension()`
 * provider of this feature instead (modules/records/README.md, step 7).
 */
@Injectable()
export class GeneratedItemsService {
  constructor(private readonly records: RecordStore<GeneratedItem>) {}

  /** `dto` goes along as `input`: the add-ons' hooks read their keys from it. */
  create(owner: Principal, dto: CreateGeneratedItemDto) {
    // Business logic: check or derive values before the write.
    return this.records.create(owner, recordValues(GENERATED_ITEM, dto), {
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
    dto: UpdateGeneratedItemDto,
    check?: CurrentCheck<GeneratedItem>,
  ) {
    // Business logic: what a change must respect, in `check` (on the locked row) or here.
    return this.records.update(by, id, recordValues(GENERATED_ITEM, dto), {
      check,
      input: dto,
    });
  }

  delete(by: Principal, id: string, check?: CurrentCheck<GeneratedItem>) {
    return this.records.delete(by, id, { check });
  }
}
