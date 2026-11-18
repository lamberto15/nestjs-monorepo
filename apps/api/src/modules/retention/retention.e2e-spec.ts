import { Injectable, Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import {
  createRetentionItems,
  retentionItems,
} from '../../../test/fixtures/retention/retention-items.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { HoldsModule } from '../../iam/holds/holds.module.js';
import { RecordPurge, type RecordPurger } from './record-purge.js';
import { RetentionModule } from './retention.module.js';
import { RetentionScheduler } from './retention.scheduler.js';
import { RETENTION_BATCH, RETENTION_QUEUE } from './retention.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.APP_ROLE = 'all';
  process.env.REDIS_PREFIX = `test-retention-${process.pid}-${Date.now()}`;
});

const DAY = 86_400_000;

/** What the module that owns the records provides: what refers to a purged record goes too. */
@RecordPurge({ subject: 'RetentionItem' })
@Injectable()
class ItemsPurger implements RecordPurger {
  readonly forgotten: string[] = [];

  forget(_subject: string, recordIds: readonly string[]) {
    this.forgotten.push(...recordIds);
    return Promise.resolve();
  }
}

@Module({
  imports: [
    RetentionModule.forFeature({
      name: 'item',
      label: 'Items',
      subject: 'RetentionItem',
      table: retentionItems,
      ageColumn: retentionItems.createdAt,
      action: 'purge',
      defaultDays: 30,
      minDays: 7,
    }),
    RetentionModule.forFeature({
      name: 'item-body',
      label: 'Item bodies',
      subject: 'RetentionItem',
      table: retentionItems,
      ageColumn: retentionItems.createdAt,
      action: 'anonymise',
      defaultDays: 30,
      anonymise: {
        set: { body: null },
        pending: isNotNull(retentionItems.body),
      },
    }),
  ],
  providers: [ItemsPurger],
})
class ItemsModule {}

type Headers = Record<string, string>;

describe('retention (e2e)', () => {
  let app: NestNodeApplication;
  let queue: Queue;
  let tenantId: string;
  let admin: Headers;
  let editor: Headers;
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(id: string, work: () => Promise<T>) =>
    app.get(Tenancy).run(id, work);

  beforeAll(async () => {
    await createRetentionItems(process.env.DATABASE_OWNER_URL!);
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      HoldsModule,
      RetentionModule,
      ItemsModule,
    );
    queue = app.get(getQueueToken(RETENTION_QUEUE));
    await queue.obliterate({ force: true });
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    admin = tenant.admin.headers;
    editor = (await member(app, tenantId, ['editor'])).headers;
  });
  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const setRule = (name: string, body: object, headers = admin) =>
    call('PUT', `/v1/retention/rules/${name}`, headers, body);
  const hold = (recordId: string) =>
    call('POST', '/v1/legal-holds', admin, {
      subject: 'RetentionItem',
      recordId,
      reason: 'Case 3',
    });

  /** Items of a tenant, `ageDays` old (`count` of them). */
  async function items(ageDays: number, count = 1, tenant = tenantId) {
    const rows = await inTenant(tenant, () =>
      db()
        .insert(retentionItems)
        .values(
          Array.from({ length: count }, () => ({
            body: 'secret',
            createdAt: new Date(Date.now() - ageDays * DAY),
          })),
        )
        .returning({ id: retentionItems.id }),
    );
    return rows.map((row) => row.id);
  }
  const rows = (ids: string[], tenant = tenantId) =>
    inTenant(tenant, () =>
      db()
        .select({ id: retentionItems.id, body: retentionItems.body })
        .from(retentionItems)
        .where(inArray(retentionItems.id, ids)),
    );
  const audited = (action: string, tenant = tenantId) =>
    inTenant(tenant, () =>
      db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, action))),
    );

  /** The scheduler's run and the worker's batches it queues, to the end. */
  async function runRetention() {
    const queued = await app.get(RetentionScheduler).run();
    await vi.waitFor(
      async () => {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed');
        expect(counts).toEqual({ waiting: 0, active: 0, delayed: 0 });
      },
      { timeout: 60_000, interval: 50 },
    );
    return queued;
  }
  const rule = async (name: string, headers = admin) =>
    (await call('GET', '/v1/retention/rules', headers))
      .json()
      .items.find((r: { name: string }) => r.name === name);

  it('lists the declared rules, off until the tenant turns one on, with its minimum', async () => {
    expect((await call('GET', '/v1/retention/rules', editor)).statusCode).toBe(
      403,
    );
    expect((await setRule('item', { enabled: true }, editor)).statusCode).toBe(
      403,
    );
    expect(await rule('item')).toMatchObject({
      subject: 'RetentionItem',
      action: 'purge',
      enabled: false,
      days: 30,
      defaultDays: 30,
      minDays: 7,
      lastRunAt: null,
    });

    const tooShort = await setRule('item', { enabled: true, days: 3 });
    expect(tooShort.statusCode).toBe(400);
    expect(tooShort.json().code).toBe('validation_failed');
    expect((await setRule('nope', { enabled: true })).statusCode).toBe(404);

    expect(
      (await setRule('item', { enabled: true, days: 60 })).json(),
    ).toMatchObject({ enabled: true, days: 60 });
    // Only the switch: the days stay.
    expect((await setRule('item', { enabled: false })).json()).toMatchObject({
      enabled: false,
      days: 60,
    });
    expect(
      (await audited('retention.policy-changed')).filter(
        (entry) => entry.targetId === 'item',
      ),
    ).toHaveLength(2);
    await setRule('item', { enabled: false, days: 30 });
  });

  it('previews what a run would take, and what a hold keeps, without changing anything', async () => {
    const [old, heldOld] = await items(40, 2);
    await items(5);
    await hold(heldOld!);

    const preview = await call(
      'GET',
      '/v1/retention/rules/item/preview',
      admin,
    );
    expect(preview.json()).toMatchObject({
      name: 'item',
      days: 30,
      due: 1,
      held: 1,
    });
    const wider = await call(
      'GET',
      '/v1/retention/rules/item/preview?days=7',
      admin,
    );
    expect(wider.json()).toMatchObject({ days: 7, due: 1, held: 1 });
    const narrow = await call(
      'GET',
      '/v1/retention/rules/item/preview?days=60',
      admin,
    );
    expect(narrow.json()).toMatchObject({ days: 60, due: 0, held: 0 });
    expect(
      (await call('GET', '/v1/retention/rules/item/preview?days=3', admin))
        .statusCode,
    ).toBe(400);
    expect(
      (await call('GET', '/v1/retention/rules/nope/preview', admin)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', '/v1/retention/rules/item/preview', editor))
        .statusCode,
    ).toBe(403);
    expect(await rows([old!, heldOld!])).toHaveLength(2);
  });

  it('purges the old records of an enabled rule on the queue, sparing the young and the held', async () => {
    const t = await tenantWithAdmin(app);
    const [old, heldOld] = await items(40, 2, t.tenantId);
    const [young] = await items(5, 1, t.tenantId);
    const placed = await call('POST', '/v1/legal-holds', t.admin.headers, {
      subject: 'RetentionItem',
      recordId: heldOld,
      reason: 'Case 3',
    });

    // Declared, not turned on: nothing is queued for this tenant, nothing goes.
    await runRetention();
    expect(await rows([old!, heldOld!, young!], t.tenantId)).toHaveLength(3);

    await setRule('item', { enabled: true }, t.admin.headers);
    expect(await runRetention()).toBe(1);
    expect(
      (await rows([old!, heldOld!, young!], t.tenantId))
        .map((r) => r.id)
        .sort(),
    ).toEqual([heldOld!, young!].sort());

    const purged = await audited('retention.purged', t.tenantId);
    expect(purged).toHaveLength(1);
    expect(purged[0]).toMatchObject({
      actor: 'system:retention',
      details: { rule: 'item', ids: [old], retentionDays: 30 },
    });
    expect(await rule('item', t.admin.headers)).toMatchObject({
      lastCount: 1,
      lastRunAt: expect.any(String),
    });
    // What refers to the purged record goes with it (@RecordPurge).
    expect(app.get(ItemsPurger).forgotten).toEqual([old]);

    // The hold ends; the next night it goes too.
    const hold = placed.json();
    await call(
      'POST',
      `/v1/legal-holds/${hold.id}/release`,
      t.admin.headers,
      {},
    );
    await runRetention();
    expect(
      (await rows([heldOld!, young!], t.tenantId)).map((r) => r.id),
    ).toEqual([young]);
    await setRule('item', { enabled: false }, t.admin.headers);
  });

  it('anonymises instead: the rows stay, what identifies is overwritten, once', async () => {
    const t = await tenantWithAdmin(app);
    const [old] = await items(40, 1, t.tenantId);
    const [young] = await items(5, 1, t.tenantId);
    await setRule('item-body', { enabled: true }, t.admin.headers);
    await runRetention();
    const after = await rows([old!, young!], t.tenantId);
    expect(after.find((r) => r.id === old)?.body).toBeNull();
    expect(after.find((r) => r.id === young)?.body).toBe('secret');
    expect(await audited('retention.anonymised', t.tenantId)).toHaveLength(1);
    // Anonymised rows are no longer pending: the next night writes nothing.
    await runRetention();
    expect(await audited('retention.anonymised', t.tenantId)).toHaveLength(1);
    await setRule('item-body', { enabled: false }, t.admin.headers);
  });

  it('carries on past a full batch, and touches only the tenant that turned the rule on', async () => {
    const mine = await tenantWithAdmin(app);
    const theirs = await tenantWithAdmin(app);
    const many = await items(40, RETENTION_BATCH + 1, mine.tenantId);
    const [kept] = await items(40, 1, theirs.tenantId);
    await setRule('item', { enabled: true }, mine.admin.headers);
    await setRule('item', { enabled: false }, theirs.admin.headers);

    expect(await runRetention()).toBe(1); // this tenant's rule alone
    expect(await rows(many, mine.tenantId)).toHaveLength(0);
    expect(await rows([kept!], theirs.tenantId)).toHaveLength(1);
    expect(await audited('retention.purged', mine.tenantId)).toHaveLength(2);
    expect(await rule('item', mine.admin.headers)).toMatchObject({
      lastCount: RETENTION_BATCH + 1,
    });
    await setRule('item', { enabled: false }, mine.admin.headers);
  });
});
