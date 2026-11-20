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
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can, Policy } from '@nestjs/authorization';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import { DataTransferModule } from '../../../src/modules/data-transfer/data-transfer.module.js';
import {
  type RecordDeclaration,
  type RecordTable,
  recordValues,
} from '../../../src/modules/records/record.js';
import { recordList } from '../../../src/modules/records/record.list.js';
import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { RecordPolicy } from '../../../src/modules/records/record.policy.js';
import {
  IncludePipe,
  type RecordInclude,
  RecordPresenter,
} from '../../../src/modules/records/record.presenter.js';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import { RecordStore } from '../../../src/modules/records/record.store.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { SequencesModule } from '../../../src/modules/sequences/sequences.module.js';
import { KEYED_BOOK, KEYED_LOAN, KEYED_SHELF } from './keyed.records.js';
import { keyedBooks, keyedLoans, keyedShelves } from './keyed.tables.js';

/**
 * One keyed record as a feature wires it: create, list and read routes,
 * exportable and importable; `imports` adds its add-ons (a loan's numbering).
 */
function keyedRecordModule(
  declaration: RecordDeclaration,
  table: RecordTable,
  imports: Type[] | ReturnType<typeof SequencesModule.forRecord>[] = [],
) {
  const schemas = recordSchemas(declaration);

  @Policy()
  class KeyedPolicy extends RecordPolicy {}

  @Injectable()
  class KeyedService {
    constructor(readonly records: RecordStore) {}
  }

  @Controller(declaration.path)
  class KeyedController {
    constructor(
      private readonly service: KeyedService,
      private readonly authorization: AuthorizationService,
      private readonly presenter: RecordPresenter,
    ) {}

    @Post()
    @Can(KeyedPolicy, 'create')
    async create(
      @CurrentUser() user: RequestPrincipal,
      @Body({ schema: schemas.create }) dto: Record<string, unknown>,
    ) {
      return this.presenter.one(
        user,
        await this.service.records.create(
          user,
          recordValues(declaration, dto),
          { input: dto },
        ),
      );
    }

    @Get()
    @Can.Anyone() // Only those the caller may read: filtered in the query.
    async list(
      @CurrentUser() user: RequestPrincipal,
      @Query() raw: Record<string, unknown>,
      @Query('include', IncludePipe) include: RecordInclude,
    ) {
      const { list, query } = await this.presenter.query(user, raw);
      const page = await this.service.records.findPage(user, list, query);
      return this.presenter.page(user, page, { list, query, include });
    }

    @Get(':id')
    @Can.Anyone() // Checked below, on the record itself.
    async get(
      @CurrentUser() user: RequestPrincipal,
      @Param('id', ParseUUIDPipe) id: string,
      @Query('include', IncludePipe) include: RecordInclude,
    ) {
      const row = await this.service.records.findOne(id, { visibleTo: user });
      await this.authorization.authorize(KeyedPolicy, 'read', user, row);
      return this.presenter.one(user, row, include);
    }
  }

  @Module({
    imports: [
      AccessModule.forFeature(recordPermissions(declaration, table)),
      RecordsModule.forFeature(declaration, {
        table,
        list: recordList(declaration, table),
        schemas,
        policy: KeyedPolicy,
      }),
      DataTransferModule.forRecord(declaration),
      ...imports,
    ],
    controllers: [KeyedController],
    providers: [KeyedService, KeyedPolicy],
  })
  class KeyedRecordModule {}
  return KeyedRecordModule;
}

/** Shelves, books (keyed within their shelf) and loans (keyed by a naming series' reference). */
export const keyedModules = () => [
  keyedRecordModule(KEYED_SHELF, keyedShelves as unknown as RecordTable),
  keyedRecordModule(KEYED_BOOK, keyedBooks as unknown as RecordTable),
  keyedRecordModule(KEYED_LOAN, keyedLoans as unknown as RecordTable, [
    SequencesModule.forRecord(
      KEYED_LOAN,
      { prefix: 'LN', width: 4 },
      { field: 'reference' },
    ),
  ]),
];
