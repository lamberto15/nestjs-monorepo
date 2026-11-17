import { Get, Module } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { RecordController } from '../../../src/modules/records/record-extension.js';
import { bootModules } from '../../boot.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../records.js';
import { QuotasModule } from '../../../src/modules/quotas/quotas.module.js';
import { TestMarksModule } from './marks/marks.js';
import { MARKS_RESPONSE } from './marks/marks.schemas.js';
import { TEST_ITEM } from './test-item.record.js';
import { testItemsModule, testItemsWithMarks } from './test-items.module.js';

/** Another add-on that mounts a controller of the marks' name. */
@RecordController(TEST_ITEM, ':id/other-marks', 'Marks')
class SameName {
  @Get()
  @Can.Anyone()
  get() {
    return {};
  }
}

@Module({ controllers: [SameName] })
class SameNameModule {}

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `two-apps-${process.pid}:`;
});

/**
 * Two apps in one process with the same record and add-on (two e2e
 * suites in one worker do this): each checks its own controllers. And a
 * record's stock quota, an option of RecordsModule.forFeature().
 */
describe('records: two apps in one process (e2e)', () => {
  let first: NestNodeApplication;
  let second: NestNodeApplication;

  beforeAll(async () => {
    first = await bootModules(...testItemModules(), testItemsWithMarks());
    second = await bootModules(
      ...testItemModules(),
      QuotasModule,
      testItemsModule({ quota: { label: 'Test items', default: 2 } }),
    );
  });

  afterAll(async () => {
    await first?.close();
    await second?.close();
  });

  it('serves the same record in both', async () => {
    for (const app of [first, second]) {
      const { editor } = await recordsTenant(app);
      const item = await createTestItem(app, editor.headers);
      const read = await app.inject({
        method: 'GET',
        url: `/v1/test-items/${item.id}`,
        headers: editor.headers,
      });
      expect(read.statusCode).toBe(200);
    }
  });

  it("refuses a record's live records past its quota (422)", async () => {
    const { editor } = await recordsTenant(second);
    const a = await createTestItem(second, editor.headers);
    await createTestItem(second, editor.headers);
    const past = await second.inject({
      method: 'POST',
      url: '/v1/test-items',
      headers: editor.headers,
      payload: { title: 'Third' },
    });
    expect(past.statusCode).toBe(422);
    expect(past.json().code).toBe('quota_exceeded');
    // One in the recycle bin leaves room.
    await second.inject({
      method: 'DELETE',
      url: `/v1/test-items/${a.id}`,
      headers: editor.headers,
    });
    await createTestItem(second, editor.headers);
  });

  it('refuses two controllers of one name in one app', async () => {
    await expect(
      bootModules(
        ...testItemModules(),
        testItemsModule({
          imports: [TestMarksModule.forRecord(TEST_ITEM), SameNameModule],
          response: MARKS_RESPONSE,
        }),
      ),
    ).rejects.toThrow(
      /Two record controllers are named TestItemMarksController/,
    );
  });
});
