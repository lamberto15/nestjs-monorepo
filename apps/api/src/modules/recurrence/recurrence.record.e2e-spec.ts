import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { recordsTenant, testItemModules } from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { RECORD_SCHEDULE_JOB } from './recurrence.permissions.js';
import { RecurrenceModule } from './recurrence.module.js';
import { RecurrenceService } from './recurrence.service.js';
import { recordSchedules } from './recurrence.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  // No processors: the test runs what is due itself.
  process.env.APP_ROLE = 'api';
  process.env.REDIS_PREFIX = `test-record-recurrence-${process.pid}-${Date.now()}`;
});

describe('a record as a schedule target (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      RecurrenceModule,
      testItemsModule({ imports: [RecurrenceModule.forRecord(TEST_ITEM)] }),
    );
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  const schedule = (payload: object) =>
    app.inject({
      method: 'POST',
      url: '/v1/record-schedules',
      headers: team.editor.headers,
      payload: {
        name: 'Weekly',
        target: 'test-items',
        rrule: 'FREQ=DAILY',
        startDate: '2020-01-01',
        time: '08:00',
        timezone: 'UTC',
        ...payload,
      },
    });

  it('creates the record from the template at each occurrence, as its owner', async () => {
    // A template is one create body of the record.
    expect((await schedule({ template: { title: 5 } })).statusCode).toBe(400);

    const made = await schedule({
      template: { title: 'Stand-up', status: 'done' },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json().id as string;
    const db = app.get<Database>(getDrizzleToken());
    const [{ nextRunAt }] = (await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        db.select().from(recordSchedules).where(eq(recordSchedules.id, id)),
      )) as { nextRunAt: Date }[];

    await app
      .get(SystemContext)
      .run(
        RECORD_SCHEDULE_JOB,
        (system) =>
          app
            .get(RecurrenceService)
            .runTenant(system, new Date(nextRunAt.getTime())),
        { tenantId: team.tenantId, transaction: false },
      );

    const list = await app.inject({
      method: 'GET',
      url: '/v1/test-items',
      headers: team.editor.headers,
    });
    const items = list.json().items as {
      title: string;
      status: string;
      ownerId: string;
    }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Stand-up',
      status: 'done',
      ownerId: `user:${team.editor.id}`,
    });
  });
});
