import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can, Policy } from '@nestjs/authorization';
import type { z } from 'zod';
import type { List, ListQuery } from '../../../src/core/http/list-query.js';
import { Etag } from '../../../src/core/http/etag.js';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import { recordList } from '../../../src/modules/records/record.list.js';
import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { RecordPolicy } from '../../../src/modules/records/record.policy.js';
import {
  IncludePipe,
  type RecordInclude,
  RecordPresenter,
} from '../../../src/modules/records/record.presenter.js';
import { recordValues } from '../../../src/modules/records/record.js';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import { RecordStore } from '../../../src/modules/records/record.store.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import {
  NUMBER_BODY,
  NUMBER_RESPONSE,
} from '../../../src/modules/sequences/sequences.record.js';
import { SequencesModule } from '../../../src/modules/sequences/sequences.module.js';
import { NUMBERED_ITEM } from './numbered-item.record.js';
import { numberedItems } from './numbered-items.tables.js';

const SCHEMAS = recordSchemas(NUMBERED_ITEM, {
  body: NUMBER_BODY,
  response: NUMBER_RESPONSE,
});
type CreateDto = z.infer<typeof SCHEMAS.create>;
const LIST = recordList(NUMBERED_ITEM, numberedItems);
const PERMISSIONS = recordPermissions(NUMBERED_ITEM, numberedItems);

@Policy()
class NumberedItemPolicy extends RecordPolicy {}

@Injectable()
class NumberedItemsService {
  constructor(
    private readonly records: RecordStore<typeof numberedItems.$inferSelect>,
  ) {}

  create(owner: RequestPrincipal, dto: CreateDto) {
    return this.records.create(owner, recordValues(NUMBERED_ITEM, dto), {
      input: dto,
    });
  }

  findOne(id: string, user: RequestPrincipal) {
    return this.records.findOne(id, { visibleTo: user });
  }

  findPage(user: RequestPrincipal, list: List, query: ListQuery) {
    return this.records.findPage(user, list, query);
  }
}

@Controller('numbered-items')
class NumberedItemsController {
  constructor(
    private readonly items: NumberedItemsService,
    private readonly authorization: AuthorizationService,
    private readonly presenter: RecordPresenter,
  ) {}

  @Post()
  @Etag()
  @Can(NumberedItemPolicy, 'create')
  async create(
    @CurrentUser() user: RequestPrincipal,
    @Body({ schema: SCHEMAS.create }) dto: CreateDto,
  ) {
    return this.presenter.one(user, await this.items.create(user, dto));
  }

  @Get()
  @Etag()
  @Can.Anyone() // Only those the caller may read: filtered in the query.
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Query() raw: Record<string, unknown>,
    @Query('include', IncludePipe) include: RecordInclude,
  ) {
    const { list, query } = await this.presenter.query(user, raw);
    const page = await this.items.findPage(user, list, query);
    return this.presenter.page(user, page, { list, query, include });
  }

  @Get(':id')
  @Etag()
  @Can.Anyone() // Checked below, on the record itself.
  async get(
    @CurrentUser() user: RequestPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const row = await this.items.findOne(id, user);
    await this.authorization.authorize(NumberedItemPolicy, 'read', user, row);
    return this.presenter.one(user, row);
  }
}

/** A numbered record, as a feature module wires one: its numbering is one import. */
@Module({
  imports: [
    AccessModule.forFeature(PERMISSIONS),
    RecordsModule.forFeature(NUMBERED_ITEM, {
      table: numberedItems,
      list: LIST,
      schemas: SCHEMAS,
      policy: NumberedItemPolicy,
    }),
    SequencesModule.forRecord(NUMBERED_ITEM, { prefix: 'NI', width: 4 }),
  ],
  controllers: [NumberedItemsController],
  providers: [NumberedItemsService, NumberedItemPolicy],
})
export class NumberedItemsModule {}
