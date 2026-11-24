import { randomUUID } from 'node:crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import { OutboxRelay } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { member } from '../../../test/access.js';
import { apiClient } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { deliverWebhooks, webhookReceiver } from '../../../test/webhooks.js';
import type { Database } from '../../core/database/database.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { rolePermissions, roles } from '../../iam/access/access.tables.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { notifications } from '../notifications/notifications.tables.js';
import { PUSH_QUEUE } from '../notifications/notifications.push.js';
import { WebhooksModule } from '../webhooks/webhooks.module.js';
import { AutomationsModule } from './automations.module.js';
import { AutomationRunRetentionJob } from './automations.retention.job.js';
import { automationRuns } from './automations.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    OUTBOX_RELAY: 'off',
    WEBHOOKS_WORKER: 'off',
    WEBHOOKS_ALLOW_LOOPBACK: 'on',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-automations-${process.pid}-${Date.now()}`,
  });
});

type Rule = Record<string, unknown> & { id: string };

describe('automation rules (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, work);
  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
    headers: Headers = team.admin.headers,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  /** Runs what the committed writes published: the rules' runs. */
  const run = () => app.get(OutboxRelay).runOnce();
  const item = (body: object, headers = team.admin.headers) =>
    createTestItem(app, headers, { body: 'Text', ...body });
  const read = async (id: string) =>
    (await call('GET', `/v1/test-items/${id}`)).json<Record<string, unknown>>();
  const rule = async (body: object) => {
    const created = await call('POST', '/v1/automation-rules', {
      name: `Rule ${randomUUID().slice(0, 6)}`,
      subject: 'TestItem',
      trigger: 'created',
      ...body,
    });
    expect(created.statusCode).toBe(201);
    return created.json<Rule>();
  };
  const activate = async (id: string) => {
    const active = await call('POST', `/v1/automation-rules/${id}/activate`);
    expect(active.statusCode).toBe(200);
    return active.json<Rule>();
  };
  const runsOf = async (id: string, query = '') =>
    (await call('GET', `/v1/automation-rules/${id}/runs${query}`)).json<{
      items: Record<string, unknown>[];
    }>().items;
  const audit = (targetId: string) =>
    inTenant(() =>
      db().select().from(auditLog).where(eq(auditLog.targetId, targetId)),
    );

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      WebhooksModule,
      AutomationsModule,
      testItemsModule({ imports: [AutomationsModule.forRecord(TEST_ITEM)] }),
    );
  });
  beforeEach(async () => {
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    if (!app) return;
    for (const name of [MAIL_QUEUE, PUSH_QUEUE]) {
      await app.get<Queue>(getQueueToken(name)).obliterate({ force: true });
    }
    await app.close();
  });

  it('simulates without effects, then runs the same actions once activated, never on its own writes', async () => {
    const definition = {
      subject: 'TestItem',
      trigger: 'created',
      condition: "status == 'done'",
      actions: [
        { type: 'setField', field: 'body', value: 'Escalated' },
        { type: 'notify', userIds: [team.admin.id] },
      ],
    };
    const matching = await item({ title: 'An urgent thing', status: 'done' });
    await item({ title: 'A calm thing' });

    const simulated = await call('POST', '/v1/automation-rules/simulate', {
      ...definition,
      limit: 10,
    });
    expect(simulated.statusCode).toBe(200);
    expect(simulated.json()).toEqual({
      subject: 'TestItem',
      limit: 10,
      matched: 1,
      truncated: false,
      triggerSimulated: true,
      matches: [
        {
          recordId: matching.id,
          title: 'An urgent thing',
          actions: [
            {
              type: 'setField',
              allowed: true,
              reason: null,
              detail: 'body = "Escalated"',
            },
            { type: 'notify', allowed: true, reason: null, detail: '1 of 1' },
          ],
        },
      ],
    });
    expect((await read(matching.id)).body).toBe('Text');

    const created = await rule({ name: 'Escalate done items', ...definition });
    expect(created).toMatchObject({ status: 'draft', version: 1, owner: null });
    // A draft runs nothing.
    await item({ status: 'done' });
    await run();
    expect(await runsOf(created.id)).toEqual([]);

    expect(await activate(created.id)).toMatchObject({
      status: 'active',
      owner: `user:${team.admin.id}`,
    });
    // A rule on the field the first one sets: the first one's write must not start it.
    const loop = await rule({
      trigger: 'updated',
      field: 'body',
      actions: [{ type: 'setField', field: 'body', value: 'Again' }],
    });
    await activate(loop.id);

    const target = await item({ title: 'Done now', status: 'done' });
    const calm = await item({ title: 'Calm' });
    await run();
    await run(); // anything the actions published (no rule: no loop)

    expect((await read(target.id)).body).toBe('Escalated');
    expect((await read(calm.id)).body).toBe('Text');
    const runs = await runsOf(created.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      recordId: target.id,
      ruleVersion: 1,
      status: 'succeeded',
      error: null,
    });
    // What the run did is what the simulation showed.
    expect(runs[0]!.actions).toEqual([
      {
        type: 'setField',
        allowed: true,
        reason: null,
        detail: 'body = "Escalated"',
      },
      { type: 'notify', allowed: true, reason: null, detail: '1 of 1' },
    ]);
    expect(await runsOf(loop.id)).toEqual([]);
    const told = await inTenant(() =>
      db()
        .select({ data: notifications.data })
        .from(notifications)
        .where(eq(notifications.type, 'automation.notified')),
    );
    expect(told.map((n) => n.data)).toEqual([
      expect.objectContaining({
        rule: 'Escalate done items',
        recordId: target.id,
        title: 'Done now',
      }),
    ]);
    // Audited as the owner, as their own change.
    expect((await audit(target.id)).map((e) => [e.action, e.actor])).toEqual(
      expect.arrayContaining([['testItem.updated', `user:${team.admin.id}`]]),
    );

    // A change of what it does: a new version, a draft until activated again.
    const changed = await call('PATCH', `/v1/automation-rules/${created.id}`, {
      condition: "status == 'draft'",
    });
    expect(changed.json()).toMatchObject({ status: 'draft', version: 2 });
    expect((await audit(created.id)).map((e) => e.action).sort()).toEqual([
      'automation-rule.activated',
      'automation-rule.created',
      'automation-rule.updated',
    ]);
  });

  it('runs an update rule only when its field changed', async () => {
    const watching = await rule({
      trigger: 'updated',
      field: 'status',
      actions: [{ type: 'setField', field: 'title', value: 'Moved' }],
    });
    await activate(watching.id);
    const record = await item({ title: 'Still' });
    const patch = (payload: object) =>
      call('PATCH', `/v1/test-items/${record.id}`, payload);
    expect((await patch({ body: 'Other' })).statusCode).toBe(200);
    await run();
    expect((await read(record.id)).title).toBe('Still');
    expect((await patch({ status: 'done' })).statusCode).toBe(200);
    await run();
    expect((await read(record.id)).title).toBe('Moved');
    expect(await runsOf(watching.id)).toHaveLength(1);
  });

  it('keeps failed runs visible, disables a failing rule, and stops a disabled one', async () => {
    // A member who doesn't exist: nobody may be told.
    const failing = await rule({
      actions: [{ type: 'notify', userIds: [randomUUID()] }],
    });
    await activate(failing.id);
    for (let i = 0; i < 5; i++) {
      await item({ title: `Item ${i}` });
      await run();
    }
    expect(
      (await call('GET', `/v1/automation-rules/${failing.id}`)).json(),
    ).toMatchObject({
      status: 'disabled',
      disabledReason: 'failing',
      lastStatus: 'failed',
      failures: 5,
    });
    const failed = await runsOf(failing.id, '?status=failed');
    expect(failed).toHaveLength(5);
    expect(failed[0]).toMatchObject({
      error: 'notify: no_recipient',
      actions: [{ type: 'notify', allowed: false, reason: 'no_recipient' }],
    });
    expect(
      (await audit(failing.id)).find(
        (e) => e.action === 'automation-rule.disabled',
      ),
    ).toMatchObject({
      actor: 'system:automations',
      details: { reason: 'failing' },
    });

    // Disabled by hand: queued runs find it disabled and do nothing.
    const other = await rule({
      actions: [{ type: 'setField', field: 'body', value: 'Changed' }],
    });
    await activate(other.id);
    const queued = await item({ title: 'Queued' });
    expect(
      (await call('POST', `/v1/automation-rules/${other.id}/disable`)).json(),
    ).toMatchObject({ status: 'disabled', disabledReason: 'manual' });
    await run();
    expect((await read(queued.id)).body).toBe('Text');
    expect(await runsOf(other.id)).toEqual([]);
  });

  it('refuses what it should: no permission, a bad definition, a condition on a hidden field', async () => {
    const editor = team.editor.headers;
    expect(
      (await call('GET', '/v1/automation-rules', undefined, editor)).statusCode,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          '/v1/automation-rules/simulate',
          {
            subject: 'TestItem',
            trigger: 'created',
            actions: [{ type: 'webhook' }],
          },
          editor,
        )
      ).statusCode,
    ).toBe(403);

    const paths = async (body: object) => {
      const refused = await call('POST', '/v1/automation-rules', {
        name: 'Bad',
        subject: 'TestItem',
        trigger: 'created',
        actions: [{ type: 'setField', field: 'title', value: 'x' }],
        ...body,
      });
      expect(refused.statusCode).toBe(400);
      return refused
        .json<{ errors: { path: string }[] }>()
        .errors.map((e) => e.path);
    };
    expect(await paths({ subject: 'Nope' })).toEqual(['subject']);
    expect(await paths({ field: 'title' })).toEqual(['field']);
    expect(await paths({ condition: 'nope == 1' })).toEqual(['condition']);
    expect(await paths({ condition: 'title' })).toEqual(['condition']);
    expect(
      await paths({
        actions: [{ type: 'setField', field: 'parentId', value: 'x' }],
      }),
    ).toEqual(['actions.0.field']);
    expect(
      await paths({
        actions: [{ type: 'setField', field: 'status', value: 'nope' }],
      }),
    ).toEqual(['actions.0.value']);
    expect(await paths({ actions: [{ type: 'teleport' }] })).toEqual([
      'actions.0.type',
    ]);
    expect(await paths({ actions: [{ type: 'notify' }] })).toEqual([
      'actions.0.userIds',
    ]);

    // Someone who configures rules but may not read test items' bodies.
    const roleId = await inTenant(async () => {
      const [role] = await db()
        .insert(roles)
        .values({ name: 'Rules without bodies' })
        .returning();
      await db()
        .insert(rolePermissions)
        .values([
          {
            roleId: role!.id,
            subject: 'AutomationRule',
            action: 'read',
            conditions: [],
          },
          {
            roleId: role!.id,
            subject: 'AutomationRule',
            action: 'configure',
            conditions: [],
          },
          {
            roleId: role!.id,
            subject: 'TestItem',
            action: 'read',
            conditions: [],
            fields: [],
          },
        ]);
      return role!.id;
    });
    const narrow = await member(app, team.tenantId, [roleId]);
    const definition = {
      name: 'Narrow',
      subject: 'TestItem',
      trigger: 'created',
      actions: [{ type: 'webhook' }],
    };
    const hidden = await call(
      'POST',
      '/v1/automation-rules',
      { ...definition, condition: "body == 'x'" },
      narrow.headers,
    );
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json()).toMatchObject({
      code: 'field_forbidden',
      fields: ['body'],
    });
    expect(
      (
        await call(
          'POST',
          '/v1/automation-rules',
          { ...definition, condition: "title == 'x'" },
          narrow.headers,
        )
      ).statusCode,
    ).toBe(201);

    const subjects = await call('GET', '/v1/automation-rules/subjects');
    const testItem = subjects
      .json<{
        items: {
          subject: string;
          actions: { type: string; fields?: string[] }[];
        }[];
      }>()
      .items.find((s) => s.subject === 'TestItem');
    expect(testItem?.actions.map((a) => a.type)).toEqual([
      'notify',
      'setField',
      'webhook',
    ]);
    const settable = testItem?.actions.find(
      (a) => a.type === 'setField',
    )?.fields;
    expect(settable).toEqual(
      expect.arrayContaining(['title', 'body', 'status']),
    );
    expect(settable).not.toContain('parentId');
    expect(settable).not.toContain('words');
  });

  it('sends the webhook to the API clients subscribed that may read the record', async () => {
    const receiver = await webhookReceiver();
    try {
      const client = await apiClient(app, team.tenantId);
      const endpoint = await call(
        'POST',
        '/v1/webhook-endpoints',
        { url: receiver.url, eventTypes: ['testItem.automation-matched'] },
        client.headers,
      );
      expect(endpoint.statusCode).toBe(201);
      const hook = await rule({
        name: 'Tell systems',
        actions: [{ type: 'webhook' }],
      });
      await activate(hook.id);
      // The client's own record (it reads its own), and the admin's (it may not).
      const own = await item({ title: 'From the client' }, client.headers);
      await item({ title: "The admin's" });
      await run();
      await deliverWebhooks(app);
      expect(receiver.received.map((r) => r.body.type)).toEqual([
        'testItem.automation-matched',
      ]);
      expect(receiver.received[0]!.body.data).toMatchObject({
        id: own.id,
        title: 'From the client',
        automationRule: { id: hook.id, name: 'Tell systems' },
      });
      expect((await runsOf(hook.id)).map((r) => r.status)).toEqual([
        'succeeded',
        'succeeded',
      ]);
    } finally {
      await receiver.close();
    }
  });

  it('deletes runs older than AUTOMATIONS_RUN_RETENTION_DAYS every night, and keeps recent ones', async () => {
    const { id } = await rule({
      actions: [{ type: 'setField', field: 'body', value: 'X' }],
    });
    const recordId = randomUUID();
    const values = (createdAt: Date) => ({
      ruleId: id,
      ruleVersion: 1,
      recordId,
      status: 'succeeded' as const,
      actions: [],
      createdAt,
    });
    const now = new Date();
    const [old, recent] = await inTenant(() =>
      db()
        .insert(automationRuns)
        .values([
          values(new Date(now.getTime() - 91 * 86_400_000)),
          values(new Date(now.getTime() - 89 * 86_400_000)),
        ])
        .returning({ id: automationRuns.id }),
    );
    expect(
      await app.get(AutomationRunRetentionJob).run(now),
    ).toBeGreaterThanOrEqual(1);
    const left = await inTenant(() =>
      db()
        .select({ id: automationRuns.id })
        .from(automationRuns)
        .where(eq(automationRuns.recordId, recordId)),
    );
    expect(left).toEqual([recent]);
    expect(left).not.toContainEqual(old);
  });
});
