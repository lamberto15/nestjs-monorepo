import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import type { z } from 'zod';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import { recordList } from '../../../src/modules/records/record.list.js';
import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { RecordPolicy } from '../../../src/modules/records/record.policy.js';
import { RecordPresenter } from '../../../src/modules/records/record.presenter.js';
import { recordValues } from '../../../src/modules/records/record.js';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import { RecordStore } from '../../../src/modules/records/record.store.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { NUMBER_BODY } from '../../../src/modules/sequences/sequences.record.js';
import { SequencesModule } from '../../../src/modules/sequences/sequences.module.js';
import { REFERENCED_ITEM } from './referenced-item.record.js';
import { referencedItems } from './referenced-items.tables.js';

const SCHEMAS = recordSchemas(REFERENCED_ITEM, { body: NUMBER_BODY });
type CreateDto = z.infer<typeof SCHEMAS.create>;

@Policy()
class ReferencedItemPolicy extends RecordPolicy {}

@Injectable()
class ReferencedItemsService {
  constructor(
    private readonly records: RecordStore<typeof referencedItems.$inferSelect>,
  ) {}

  create(owner: RequestPrincipal, dto: CreateDto) {
    return this.records.create(owner, recordValues(REFERENCED_ITEM, dto), {
      input: dto,
    });
  }
}

@Controller('referenced-items')
class ReferencedItemsController {
  constructor(
    private readonly items: ReferencedItemsService,
    private readonly presenter: RecordPresenter,
  ) {}

  @Post()
  @Can(ReferencedItemPolicy, 'create')
  async create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: SCHEMAS.create }) dto: CreateDto,
  ) {
    return this.presenter.one(user, await this.items.create(user, dto));
  }
}

/** A record whose own field is numbered: one import, with `{ field }`. */
@Module({
  imports: [
    AccessModule.forFeature(
      recordPermissions(REFERENCED_ITEM, referencedItems),
    ),
    RecordsModule.forFeature(REFERENCED_ITEM, {
      table: referencedItems,
      list: recordList(REFERENCED_ITEM, referencedItems),
      schemas: SCHEMAS,
      policy: ReferencedItemPolicy,
    }),
    SequencesModule.forRecord(
      REFERENCED_ITEM,
      { prefix: 'REF', width: 4 },
      { field: 'reference' },
    ),
  ],
  controllers: [ReferencedItemsController],
  providers: [ReferencedItemsService, ReferencedItemPolicy],
})
export class ReferencedItemsModule {}
