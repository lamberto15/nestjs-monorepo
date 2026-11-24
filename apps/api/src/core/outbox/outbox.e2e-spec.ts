import { randomUUID } from 'node:crypto';
import { Transactional } from '@nestjs-cls/transactional';
import { Injectable, Module } from '@nestjs/common';
import { NonRetryableMessageError, OutboxDeadLetters } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { recordMetrics } from '../../../test/metrics.js';
import {
  TenantItemsModule,
  TenantItemsService,
} from '../../../test/fixtures/tenant-items.js';
import { DatabaseModule } from '../database/database.module.js';
import { SharedLocksModule } from '../locks/locks.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { Tenancy } from '../tenancy/tenancy.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { defineEvent, Events, OnDomainEvent } from './events.js';
import { SharedOutboxModule } from './outbox.module.js';
import { OutboxRetentionJob } from './outbox-retention.job.js';

const ITEM_ADDED = defineEvent<{ name: string }>('test-item.added');
/** Nothing subscribes to this one. */
const ITEM_IGNORED = defineEvent<{ name: string }>('test-item.ignored');
const seen: { name: string; tenantId: string | null; names: string[] }[] = [];

@Injectable()
class ItemsWriter {
  constructor(
    private readonly items: TenantItemsService,
    private readonly events: Events,
  ) {}

  @Transactional()
  async add(name: string, fail = false) {
    await this.items.add(name);
    // Same key: a message without a handler would hold the next one back.
    await this.events.publish(ITEM_IGNORED, { name }, { key: name });
    await this.events.publish(ITEM_ADDED, { name }, { key: name });
    if (fail) throw new Error('rolled back');
  }
}

@Injectable()
class ItemSubscriber {
  constructor(
    private readonly items: TenantItemsService,
    private readonly tenancy: Tenancy,
  ) {}

  @OnDomainEvent(ITEM_ADDED, { consumer: 'e2e-item-subscriber' })
  async onAdded({ name }: { name: string }) {
    if (name === 'poison') {
      throw new NonRetryableMessageError('nobody can handle this');
    }
    seen.push({
      name,
      tenantId: this.tenancy.current()?.tenantId ?? null,
      names: await this.items.names(),
    });
  }
}

@Module({
  imports: [TenantItemsModule],
  providers: [ItemsWriter, ItemSubscriber],
  exports: [ItemsWriter],
})
class WriterModule {}

const DAY = 86_400_000;

describe('outbox and domain events (e2e)', () => {
  let app: NestNodeApplication;
  // Registered before the app boots, so its gauges are made on it.
  const recorded = recordMetrics();
  afterAll(() => recorded.stop());

  beforeAll(async () => {
    process.env.SCHEDULER = 'off';
    app = await bootModules(
      DatabaseModule,
      TenancyModule,
      SharedLocksModule,
      SharedOutboxModule,
      MetricsModule,
      WriterModule,
    );
  });
  afterAll(async () => {
    await app.close();
    delete process.env.SCHEDULER;
  });

  it('delivers an event after the commit, in the tenant it was published in; a rollback publishes nothing', async () => {
    const tenancy = app.get(Tenancy);
    const writer = app.get(ItemsWriter);
    const a = (await tenancy.create({ slug: 'a', name: 'A' })).id;
    const b = (await tenancy.create({ slug: 'b', name: 'B' })).id;

    await tenancy.run(a, () => writer.add('a1'));
    await tenancy.run(b, () => writer.add('b1'));
    await expect(
      tenancy.run(a, () => writer.add('lost', true)),
    ).rejects.toThrow('rolled back');
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 10_000 });
    expect(seen).toEqual(
      expect.arrayContaining([
        { name: 'a1', tenantId: a, names: ['a1'] },
        { name: 'b1', tenantId: b, names: ['b1'] },
      ]),
    );
    // Give the relay a poll to show the rolled back event never comes.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(seen.map((entry) => entry.name)).not.toContain('lost');
    // The event nobody subscribes to was never written.
    expect(await app.get(OutboxDeadLetters).list()).toHaveLength(0);
    expect((await app.get(PostgresOutboxStore).stats(Date.now())).pending).toBe(
      0,
    );
  });

  it('reports the outbox lag: 0 once everything is delivered', async () => {
    expect(await recorded.read('outbox_lag_seconds')).toEqual([
      { attributes: {}, value: 0 },
    ]);
  });

  it('refuses to publish outside a transaction', async () => {
    await expect(
      app.get(Events).publish(ITEM_ADDED, { name: 'x' }),
    ).rejects.toThrow(/inside the transaction/);
  });

  it('dead-letters an event nobody can handle, and the nightly job deletes old dead letters and inbox records', async () => {
    const writer = app.get(ItemsWriter);
    const tenancy = app.get(Tenancy);
    const tenantId = (await tenancy.create({ slug: 'p', name: 'P' })).id;
    await tenancy.run(tenantId, () => writer.add('poison'));
    const deadLetters = app.get(OutboxDeadLetters);
    await vi.waitFor(
      async () => expect(await deadLetters.list()).toHaveLength(1),
      { timeout: 10_000 },
    );

    const store = app.get(PostgresOutboxStore);
    await store.recordInbox(
      undefined,
      'e2e',
      randomUUID(),
      Date.now() - 40 * DAY,
    );
    const recent = randomUUID();
    await store.recordInbox(undefined, 'e2e', recent, Date.now() - DAY);

    const job = app.get(OutboxRetentionJob);
    expect(await job.run()).toEqual({ deadLetters: 0, inbox: 1 });
    expect(await deadLetters.list()).toHaveLength(1);
    expect(await store.hasInbox('e2e', recent)).toBe(true);

    expect(await job.run(new Date(Date.now() + 15 * DAY))).toEqual({
      deadLetters: 1,
      inbox: 0,
    });
    expect(await deadLetters.list()).toHaveLength(0);
  });
});
