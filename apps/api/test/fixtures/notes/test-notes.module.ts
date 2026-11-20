import {
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { Can, Policy } from '@nestjs/authorization';
import { InjectTransaction } from '@nestjs-cls/transactional';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../../../src/core/database/database.js';
import { AccessModule } from '../../../src/iam/access/access.module.js';
import type { RequestPrincipal } from '../../../src/iam/auth/principal.js';
import { recordList } from '../../../src/modules/records/record.list.js';
import { recordPermissions } from '../../../src/modules/records/record.permissions.js';
import { RecordPolicy } from '../../../src/modules/records/record.policy.js';
import { recordSchemas } from '../../../src/modules/records/record.schemas.js';
import { RecordsModule } from '../../../src/modules/records/records.module.js';
import { Records } from '../../../src/modules/records/records.service.js';
import { TEST_NOTE } from './test-note.record.js';
import { testNotes } from './test-notes.tables.js';

@Policy()
class TestNotePolicy extends RecordPolicy {}

/** A test item's notes, read by whoever may read the item: newest first, a page at a time. */
@Controller('test-items/:itemId/test-notes')
class TestNotesController {
  constructor(
    private readonly records: Records,
    @InjectTransaction() private readonly db: Database,
  ) {}

  @Get()
  @Can.Anyone() // Whoever may read the item: checked below.
  async list(
    @CurrentUser() user: RequestPrincipal,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('limit') limit = '10',
    @Query('cursor') cursor?: string,
  ) {
    const item = this.records.find('TestItem');
    if (!item) throw new NotFoundException();
    await item.store.findOne(itemId, { visibleTo: user });
    const size = Math.min(Math.max(Number(limit) || 10, 1), 100);
    const rows = await this.db
      .select({
        id: testNotes.id,
        itemId: testNotes.itemId,
        body: testNotes.body,
      })
      .from(testNotes)
      .where(
        and(
          eq(testNotes.itemId, itemId),
          cursor ? lt(testNotes.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(testNotes.id))
      .limit(size + 1);
    const items = rows.slice(0, size);
    return {
      items,
      nextCursor: rows.length > size ? (items.at(-1)?.id ?? null) : null,
    };
  }
}

const record = () => [
  AccessModule.forFeature(recordPermissions(TEST_NOTE, testNotes)),
  RecordsModule.forFeature(TEST_NOTE, {
    table: testNotes,
    list: recordList(TEST_NOTE, testNotes),
    schemas: recordSchemas(TEST_NOTE),
    policy: TestNotePolicy,
  }),
];

/** Test notes: read through their test item (readThrough), at its route. */
@Module({
  imports: record(),
  controllers: [TestNotesController],
  providers: [TestNotePolicy],
})
export class TestNotesModule {}

/** The same record without the route it is read at: an app that must not start. */
@Module({ imports: record(), providers: [TestNotePolicy] })
export class TestNotesWithoutRouteModule {}
