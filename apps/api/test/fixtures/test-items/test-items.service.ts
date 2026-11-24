import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '@nestjs/authorization';
import { assertUnchanged } from '../../../src/core/http/etag.js';
import { AccessService } from '../../../src/iam/access/access.service.js';
import type { Principal } from '../../../src/iam/auth/principal.js';
import { recordValues } from '../../../src/modules/records/record.js';
import {
  type RecordInclude,
  RecordPresenter,
} from '../../../src/modules/records/record.presenter.js';
import { assertWritableFields } from '../../../src/modules/records/record.routes.js';
import { RecordStore } from '../../../src/modules/records/record.store.js';
import { TestItemPolicy } from './test-item.policy.js';
import { TEST_ITEM } from './test-item.record.js';
import type {
  CreateTestItemDto,
  TestItem,
  UpdateTestItemDto,
} from './test-item.schemas.js';

/**
 * Test items: the use cases and their checks. A record the caller may not
 * read is the 404 of a missing one; one they read but may not change, a
 * 403; a change to what they read is a 412 (If-Match). What must hold for
 * every write, whoever makes it (`words`), is the feature's own hooks
 * (test-item.logic.ts); what only its routes do goes here.
 */
@Injectable()
export class TestItemsService {
  constructor(
    // The repository of a record feature: RecordStore holds its queries and
    // what every write causes in its transaction (owner, unit, recycle bin,
    // add-ons' hooks, audit, domain event), so there is no repository file.
    private readonly records: RecordStore<TestItem>,
    private readonly access: AccessService,
    private readonly authorization: AuthorizationService,
    private readonly presenter: RecordPresenter,
  ) {}

  /** `dto` goes along as `input`: the add-ons' hooks read their keys from it. */
  async create(owner: Principal, dto: CreateTestItemDto) {
    await assertWritableFields(this.access, owner, 'create', TEST_ITEM, dto);
    const row = await this.records.create(owner, recordValues(TEST_ITEM, dto), {
      input: dto,
    });
    return this.presenter.one(owner, row);
  }

  /** A page of those the caller may read: filtered in the query. */
  async findPage(
    user: Principal,
    raw: Record<string, unknown>,
    include: RecordInclude,
  ) {
    const { list, query } = await this.presenter.query(user, raw);
    const page = await this.records.findPage(user, list, query);
    return this.presenter.page(user, page, { list, query, include });
  }

  async findOne(user: Principal, id: string, include: RecordInclude) {
    const row = await this.records.findOne(id, { visibleTo: user });
    await this.authorization.authorize(TestItemPolicy, 'read', user, row);
    return this.presenter.one(user, row, include);
  }

  /** The checks run in `check`, on the locked row. */
  async update(
    by: Principal,
    id: string,
    dto: UpdateTestItemDto,
    ifMatch: string | undefined,
  ) {
    await this.records.findOne(id, { visibleTo: by });
    const updated = await this.records.update(
      by,
      id,
      recordValues(TEST_ITEM, dto),
      {
        input: dto,
        check: async (row) => {
          await this.authorization.authorize(TestItemPolicy, 'update', by, row);
          await assertWritableFields(
            this.access,
            by,
            'update',
            TEST_ITEM,
            dto,
            row,
          );
          assertUnchanged(ifMatch, await this.presenter.one(by, row));
        },
      },
    );
    return this.presenter.one(by, updated);
  }

  async delete(by: Principal, id: string, ifMatch: string | undefined) {
    await this.records.findOne(id, { visibleTo: by });
    await this.records.delete(by, id, {
      check: async (row) => {
        await this.authorization.authorize(TestItemPolicy, 'delete', by, row);
        assertUnchanged(ifMatch, await this.presenter.one(by, row));
      },
    });
  }
}
