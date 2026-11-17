import { InjectTransaction } from '@nestjs-cls/transactional';
import {
  Body,
  ConflictException,
  type DynamicModule,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Put,
  type Type,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { AuthorizationService, Can } from '@nestjs/authorization';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { and, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Database } from '../../../../src/core/database/database.js';
import type { FilterField } from '../../../../src/core/http/list-query.js';
import { OnDomainEvent } from '../../../../src/core/outbox/events.js';
import type { Principal } from '../../../../src/iam/auth/principal.js';
import type {
  RecordDeclaration,
  RecordRow,
  RecordTable,
} from '../../../../src/modules/records/record.js';
import {
  InjectRecord,
  RECORD,
  RecordController,
  RecordExtension,
  type RecordChange,
  type RecordHooks,
} from '../../../../src/modules/records/record-extension.js';
import {
  type RecordEventPayload,
  recordEvents,
} from '../../../../src/modules/records/record.events.js';
import { RecordsModule } from '../../../../src/modules/records/records.module.js';
import { Records } from '../../../../src/modules/records/records.service.js';
import { setMarksSchema } from './marks.schemas.js';
import { testRecordMarks, testRecordSeen } from './marks.tables.js';

/** The marks of records: one query for a page of them. */
@Injectable()
export class MarksService {
  constructor(@InjectTransaction() private readonly db: Database) {}

  async of(subject: string, ids: readonly string[]) {
    const marks = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (ids.length === 0) return marks;
    const rows = await this.db
      .select()
      .from(testRecordMarks)
      .where(
        and(
          eq(testRecordMarks.subject, subject),
          inArray(testRecordMarks.recordId, [...ids]),
        ),
      )
      .orderBy(testRecordMarks.mark);
    for (const row of rows) marks.get(row.recordId)?.push(row.mark);
    return marks;
  }

  /** The ids of the records with `mark`: a subquery, for a list filter. */
  idsWith(subject: string, mark: string) {
    return this.db
      .select({ id: testRecordMarks.recordId })
      .from(testRecordMarks)
      .where(
        and(
          eq(testRecordMarks.subject, subject),
          eq(testRecordMarks.mark, mark),
        ),
      );
  }

  async add(subject: string, recordId: string, mark: string) {
    await this.db
      .insert(testRecordMarks)
      .values({ subject, recordId, mark })
      .onConflictDoNothing();
  }

  /** Forgets records deleted for good. */
  async forget(subject: string, ids: readonly string[]) {
    await this.db
      .delete(testRecordMarks)
      .where(
        and(
          eq(testRecordMarks.subject, subject),
          inArray(testRecordMarks.recordId, [...ids]),
        ),
      );
  }

  /** The subscriber's note that it saw a record's `created` event. */
  async seen(subject: string, recordId: string) {
    await this.db
      .insert(testRecordSeen)
      .values({ subject, recordId })
      .onConflictDoNothing();
  }

  async set(subject: string, recordId: string, marks: string[]) {
    await this.db
      .delete(testRecordMarks)
      .where(
        and(
          eq(testRecordMarks.subject, subject),
          eq(testRecordMarks.recordId, recordId),
        ),
      );
    for (const mark of new Set(marks)) await this.add(subject, recordId, mark);
    return [...new Set(marks)].sort();
  }
}

/**
 * What marks add to a record that takes them: `marks` on it, `?mark=` on
 * its list, `?include=marked`, `capabilities.marks` and `markLimit` in its
 * list's description; in the write's transaction, an `edited` mark on
 * every change and a refusal to delete a `locked` record.
 */
@RecordExtension()
@Injectable()
export class MarksExtension implements RecordHooks {
  readonly shows = ['marks'];
  readonly capability = 'marks';
  readonly include = {
    name: 'marked',
    values: async (_principal: Principal, ids: string[]) =>
      new Map(
        [...(await this.marks.of(this.record.subject, ids))].map(
          ([id, marks]) => [id, marks.length > 0],
        ),
      ),
  };

  constructor(
    @InjectRecord() readonly record: RecordDeclaration,
    private readonly marks: MarksService,
  ) {}

  async present(_principal: Principal, views: Record<string, unknown>[]) {
    const marks = await this.marks.of(
      this.record.subject,
      views.map((view) => view.id as string),
    );
    return views.map((view) => ({
      ...view,
      marks: marks.get(view.id as string) ?? [],
    }));
  }

  filters(table: RecordTable): Record<string, FilterField> {
    return {
      mark: {
        column: table.id,
        type: 'string',
        ops: ['eq'],
        conditions: {
          eq: (value) =>
            inArray(
              table.id,
              this.marks.idsWith(this.record.subject, String(value)),
            ),
        },
      },
    };
  }

  /** Before the insert: the body's `marks` give the record's `lastMark` column. */
  async creating({ input }: { input: Record<string, unknown> }) {
    const marks = input.marks as string[] | undefined;
    return { lastMark: marks?.at(-1) ?? null };
  }

  async created({ row, input }: RecordChange) {
    const marks = input.marks as string[] | undefined;
    if (marks) await this.marks.set(this.record.subject, row.id, marks);
  }

  /**
   * Before the update, on the locked row: a `frozen` record refuses every
   * change (409, as a pending approval would); the body's `marks` replace
   * its marks and give `lastMark`.
   */
  async updating({
    before,
    input,
  }: {
    before: RecordRow;
    input: Record<string, unknown>;
  }) {
    const current = await this.marks.of(this.record.subject, [before.id]);
    if (current.get(before.id)?.includes('frozen')) {
      throw new ConflictException({
        code: 'record_frozen',
        message: 'This record is frozen: remove its "frozen" mark first.',
      });
    }
    const marks = input.marks as string[] | undefined;
    if (!marks) return;
    await this.marks.set(this.record.subject, before.id, marks);
    return { lastMark: marks.at(-1) ?? null };
  }

  async updated({ after }: { after: RecordRow }) {
    await this.marks.add(this.record.subject, after.id, 'edited');
  }

  async purged({ ids }: { ids: readonly string[] }) {
    await this.marks.forget(this.record.subject, ids);
  }

  async deleting({ row }: RecordChange) {
    const marks = await this.marks.of(this.record.subject, [row.id]);
    if (marks.get(row.id)?.includes('locked')) {
      throw new ConflictException({
        code: 'record_locked',
        message: 'This record is locked: remove its "locked" mark first.',
      });
    }
  }

  async describe() {
    return { markLimit: 10 };
  }
}

/**
 * Marks for one record: `TestMarksModule.forRecord(TEST_ITEM)` in the
 * feature module's imports. Its route, its extension, and its reaction
 * after the commit (`<item>.created`, in the worker).
 */
@Module({})
export class TestMarksModule {
  static forRecord(record: RecordDeclaration): DynamicModule {
    return {
      module: TestMarksModule,
      imports: [RecordsModule],
      controllers: [marksController(record)],
      providers: [
        { provide: RECORD, useValue: record },
        MarksService,
        MarksExtension,
        newMarker(record),
      ],
    };
  }
}

/** `PUT /<path>/{id}/marks`: whoever may change the record sets its marks. */
function marksController(record: RecordDeclaration): Type {
  @RecordController(record, ':id/marks', 'Marks')
  class MarksRoutes {
    constructor(
      private readonly records: Records,
      private readonly marks: MarksService,
      private readonly authorization: AuthorizationService,
    ) {}

    @Put()
    @Can.Anyone() // Checked below: changing the record.
    @ApiOperation({ summary: `Set a ${record.noun}'s marks` })
    @ApiOkResponse({ description: 'Its marks.' })
    async set(
      @CurrentUser() user: Principal,
      @Param('id', ParseUUIDPipe) id: string,
      @Body({ schema: setMarksSchema }) body: z.infer<typeof setMarksSchema>,
    ) {
      const { store, feature } = this.records.of(record.subject);
      // Unreadable: the 404 of a missing one; readable but not theirs to change: a 403.
      const row = await store.findOne(id, { visibleTo: user });
      await this.authorization.authorize(
        feature.policy as unknown as Type<{
          update(...args: unknown[]): boolean;
        }>,
        'update',
        user,
        row,
      );
      return { items: await this.marks.set(record.subject, id, body.marks) };
    }
  }
  return MarksRoutes;
}

/**
 * After a record of `record` is created and committed, in its tenant: a
 * note that the event came (not a mark: what a record shows changes only
 * in a write).
 */
function newMarker(record: RecordDeclaration): Type {
  @Injectable()
  class NewMarker {
    constructor(private readonly marks: MarksService) {}

    @OnDomainEvent(recordEvents(record).created, {
      consumer: `test-marks-${record.path}`,
    })
    async created({ subject, id }: RecordEventPayload) {
      await this.marks.seen(subject, id);
    }
  }
  Object.defineProperty(NewMarker, 'name', {
    value: `${record.subject}NewMarker`,
  });
  return NewMarker;
}
