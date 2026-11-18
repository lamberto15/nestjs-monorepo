import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { TestMarksModule } from '../../../test/fixtures/test-items/marks/marks.js';
import {
  MARKS_BODY,
  MARKS_RESPONSE,
} from '../../../test/fixtures/test-items/marks/marks.schemas.js';
import { testRecordMarks } from '../../../test/fixtures/test-items/marks/marks.tables.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { RetentionModule } from './retention.module.js';
import { RetentionScheduler } from './retention.scheduler.js';
import { RETENTION_QUEUE } from './retention.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-record-retention-${process.pid}-${Date.now()}`;
});

const DAY = 86_400_000;

describe('a record retention rule (e2e)', () => {
  let app: NestNodeApplication;
  let queue: Queue;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, work);

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      HoldsModule,
      RetentionModule,
      testItemsModule({
        imports: [
          TestMarksModule.forRecord(TEST_ITEM),
          RetentionModule.forRecord(TEST_ITEM, testItems, {
            defaultDays: 30,
            minDays: 7,
          }),
        ],
        response: MARKS_RESPONSE,
        body: MARKS_BODY,
      }),
    );
    queue = app.get(getQueueToken(RETENTION_QUEUE));
    await queue.obliterate({ force: true });
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await app?.close();
  });

  it('purges the old records of the record, never a held one, and their add-ons forget them', async () => {
    const old = await createTestItem(app, team.editor.headers, {
      marks: ['old'],
    });
    const held = await createTestItem(app, team.editor.headers);
    const recent = await createTestItem(app, team.editor.headers);
    await inTenant(() =>
      db()
        .update(testItems)
        .set({ createdAt: new Date(Date.now() - 90 * DAY) })
        .where(inArray(testItems.id, [old.id, held.id])),
    );
    const hold = await app.inject({
      method: 'POST',
      url: '/v1/legal-holds',
      headers: team.admin.headers,
      payload: { subject: 'TestItem', recordId: held.id, reason: 'Case 3' },
    });
    expect(hold.statusCode).toBe(201);

    const rules = await app.inject({
      method: 'GET',
      url: '/v1/retention/rules',
      headers: team.admin.headers,
    });
    expect(
      rules.json().items.find((r: { name: string }) => r.name === 'test-items'),
    ).toMatchObject({
      label: 'Test items',
      subject: 'TestItem',
      action: 'purge',
      enabled: false,
      defaultDays: 30,
    });
    const on = await app.inject({
      method: 'PUT',
      url: '/v1/retention/rules/test-items',
      headers: team.admin.headers,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);

    await app.get(RetentionScheduler).run();
    await vi.waitFor(
      async () => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0 });
      },
      { timeout: 60_000, interval: 50 },
    );

    const left = await inTenant(() =>
      db()
        .select({ id: testItems.id })
        .from(testItems)
        .where(inArray(testItems.id, [old.id, held.id, recent.id])),
    );
    expect(left.map((row) => row.id).sort()).toEqual(
      [held.id, recent.id].sort(),
    );
    // The records module's purge ran: the add-on's hook removed its marks.
    const marks = await inTenant(() =>
      db()
        .select()
        .from(testRecordMarks)
        .where(eq(testRecordMarks.recordId, old.id)),
    );
    expect(marks).toEqual([]);
  });
});
