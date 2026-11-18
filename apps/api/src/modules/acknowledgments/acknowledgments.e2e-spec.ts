import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { testItems } from '../../../test/fixtures/test-items/test-items.tables.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { notifications } from '../notifications/notifications.tables.js';
import { RecycleBinPurgeJob } from '../records/recycle-bin.job.js';
import { AcknowledgmentsModule } from './acknowledgments.module.js';
import { recordAcknowledgments } from './acknowledgments.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-acknowledgments-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

interface Ack {
  id: string;
  version: number;
  recipient: string;
  recipientName: string | null;
  acknowledgedAt: string | null;
  reminders: number;
}

describe('acknowledgments of test items (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      testItemsModule({
        imports: [AcknowledgmentsModule.forRecord(TEST_ITEM)],
      }),
    );
  });
  afterAll(() => app?.close());
  beforeEach(async () => {
    team = await recordsTenant(app);
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, work);
  const key = (who: { id: string }) => `user:${who.id}`;
  const ask = (id: string, recipients: string[], dueAt?: string) =>
    call(
      'POST',
      `/v1/test-items/${id}/acknowledgment-requests`,
      team.editor.headers,
      {
        recipients,
        ...(dueAt && { dueAt }),
      },
    );

  it('asks members who may read the record, and records their answer once', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Handbook',
    });
    const asked = await ask(item.id, [key(team.viewer), key(team.admin)]);
    expect(asked.statusCode, asked.body).toBe(201);
    expect(asked.json<Ack[]>().map((a) => [a.recipient, a.version])).toEqual(
      expect.arrayContaining([
        [key(team.viewer), 1],
        [key(team.admin), 1],
      ]),
    );
    // Asking again keeps them; only who may change the record asks.
    expect((await ask(item.id, [key(team.viewer)])).json<Ack[]>()).toHaveLength(
      1,
    );
    expect(
      (
        await call(
          'POST',
          `/v1/test-items/${item.id}/acknowledgment-requests`,
          team.viewer.headers,
          {
            recipients: [key(team.admin)],
          },
        )
      ).statusCode,
    ).toBe(403);
    const outsider = await ask(item.id, [key(team.nobody)]);
    expect(outsider.statusCode).toBe(400);
    expect(outsider.json().code).toBe('acknowledgment_recipient_invalid');
    const past = await ask(
      item.id,
      [key(team.viewer)],
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(past.json().code).toBe('acknowledgment_due_in_past');

    // The viewer is told, and sees it in their list.
    const told = await inTenant(() =>
      db()
        .select({ type: notifications.type })
        .from(notifications)
        .where(eq(notifications.recipient, key(team.viewer))),
    );
    expect(told.map((n) => n.type)).toContain('acknowledgment.requested');
    const todo = await call('GET', '/v1/acknowledgments', team.viewer.headers);
    expect(todo.json()).toMatchObject({
      items: [
        {
          recordId: item.id,
          title: 'Handbook',
          link: `/test-items/${item.id}`,
        },
      ],
    });

    const done = await call(
      'POST',
      `/v1/test-items/${item.id}/acknowledge`,
      team.viewer.headers,
    );
    expect(done.statusCode, done.body).toBe(200);
    const at = done.json<Ack>().acknowledgedAt;
    expect(at).not.toBeNull();
    const again = await call(
      'POST',
      `/v1/test-items/${item.id}/acknowledge`,
      team.viewer.headers,
    );
    expect(again.json<Ack>().acknowledgedAt).toBe(at);
    // Nobody asked the other editor: the same 404 as a record they can't read.
    expect(
      (
        await call(
          'POST',
          `/v1/test-items/${item.id}/acknowledge`,
          team.other.headers,
        )
      ).statusCode,
    ).toBe(404);

    const status = await call(
      'GET',
      `/v1/test-items/${item.id}/acknowledgments`,
      team.editor.headers,
    );
    expect(status.json()).toMatchObject({
      version: 1,
      total: 2,
      acknowledged: 1,
      pending: 1,
    });
    expect(
      (
        await call(
          'GET',
          `/v1/test-items/${item.id}/acknowledgments`,
          team.viewer.headers,
        )
      ).statusCode,
    ).toBe(403);
    const audited = await inTenant(() =>
      db()
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetType, 'TestItem'),
            eq(auditLog.targetId, item.id),
          ),
        ),
    );
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'acknowledgment.requested',
        'acknowledgment.acknowledged',
      ]),
    );
  });

  it('reminds once a day, and withdraws only an unanswered request', async () => {
    const item = await createTestItem(app, team.editor.headers);
    const asked = (
      await ask(item.id, [key(team.viewer), key(team.admin)])
    ).json<Ack[]>();
    await call(
      'POST',
      `/v1/test-items/${item.id}/acknowledge`,
      team.admin.headers,
    );
    const remind = () =>
      call(
        'POST',
        `/v1/test-items/${item.id}/acknowledgments/remind`,
        team.editor.headers,
      );
    expect((await remind()).json()).toEqual({ reminded: 1, skipped: 0 });
    expect((await remind()).json()).toEqual({ reminded: 0, skipped: 1 });

    const answered = asked.find((a) => a.recipient === key(team.admin))!;
    const open = asked.find((a) => a.recipient === key(team.viewer))!;
    const url = (id: string) =>
      `/v1/test-items/${item.id}/acknowledgments/${id}`;
    const refused = await call('DELETE', url(answered.id), team.editor.headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('acknowledgment_answered');
    expect(
      (await call('DELETE', url(open.id), team.editor.headers)).statusCode,
    ).toBe(204);
  });

  it('asks again after the record changes: a new version', async () => {
    const item = await createTestItem(app, team.editor.headers);
    await ask(item.id, [key(team.viewer)]);
    const edited = await call(
      'PATCH',
      `/v1/test-items/${item.id}`,
      team.editor.headers,
      {
        title: 'Revised',
      },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    // The request for version 1 can't be answered any more.
    expect(
      (await call('GET', '/v1/acknowledgments', team.viewer.headers)).json()
        .items,
    ).toEqual([]);
    expect(
      (
        await call(
          'POST',
          `/v1/test-items/${item.id}/acknowledge`,
          team.viewer.headers,
        )
      ).statusCode,
    ).toBe(404);
    const second = await ask(item.id, [key(team.viewer)]);
    expect(second.json<Ack[]>()[0]!.version).toBe(2);
    const first = await call(
      'GET',
      `/v1/test-items/${item.id}/acknowledgments?version=1`,
      team.editor.headers,
    );
    expect(first.json()).toMatchObject({ version: 1, total: 1 });
  });

  it('forgets the acknowledgments of a test item deleted for good', async () => {
    const item = await createTestItem(app, team.editor.headers);
    await ask(item.id, [key(team.viewer)]);
    await call('DELETE', `/v1/test-items/${item.id}`, team.editor.headers);
    await inTenant(() =>
      db()
        .update(testItems)
        .set({ deletedAt: new Date(Date.now() - 400 * 86_400_000) })
        .where(eq(testItems.id, item.id)),
    );
    expect(await app.get(RecycleBinPurgeJob).run()).toBeGreaterThanOrEqual(1);
    const left = await inTenant(() =>
      db()
        .select()
        .from(recordAcknowledgments)
        .where(eq(recordAcknowledgments.recordId, item.id)),
    );
    expect(left).toEqual([]);
  });
});
