import { randomUUID } from 'node:crypto';
import { Transactional } from '@nestjs-cls/transactional';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import { Injectable, Module } from '@nestjs/common';
import { NonRetryableMessageError, OutboxDeadLetters } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { TransactionHost } from '@nestjs-cls/transactional';
import {
  Workflow,
  WorkflowClient,
  type WorkflowContext,
} from '@nestjs/workflows';
import { type Queue, UnrecoverableError } from 'bullmq';
import { eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import {
  TenantItemsModule,
  TenantItemsService,
} from '../../../test/fixtures/tenant-items.js';
import type { Database } from '../../core/database/database.js';
import {
  defineEvent,
  Events,
  OnDomainEvent,
} from '../../core/outbox/events.js';
import { SharedOutboxModule } from '../../core/outbox/outbox.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { tenants } from '../../core/tenancy/tenancy.tables.js';
import { SharedWorkflowsModule } from '../../core/workflows/workflows.module.js';
import { SharedLocksModule } from '../../core/locks/locks.module.js';
import { RolesService } from '../../iam/access/roles.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { OpsModule } from './ops.module.js';

const OPS = await vi.hoisted(async () => {
  const slug = `ops-${process.pid}-${Date.now()}`;
  Object.assign(process.env, {
    SCHEDULER: 'off',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-ops-${process.pid}-${Date.now()}`,
    OPERATOR_TENANT: slug,
  });
  return slug;
});

const QUEUE = 'ops-test';
const POISONED = defineEvent<{ name: string }>('ops-test.poisoned');

/** A queue whose jobs all fail, with a secret in the reason. */
@Processor(QUEUE)
class FailingProcessor extends WorkerHost {
  process(): Promise<never> {
    return Promise.reject(
      new UnrecoverableError('upstream refused: password=hunter2'),
    );
  }
}

@Workflow('ops-test-failing')
class FailingWorkflow {
  async run(ctx: WorkflowContext) {
    await ctx.step('boom', () => Promise.reject(new Error('step failed')), {
      retry: false,
    });
  }
}

/** Publishes an event nobody can handle: it ends as a dead letter. */
@Injectable()
class Poisoner {
  constructor(
    private readonly items: TenantItemsService,
    private readonly events: Events,
    @InjectQueue(QUEUE) readonly queue: Queue,
  ) {}

  @Transactional()
  async poison(name: string) {
    await this.items.add(name);
    await this.events.publish(POISONED, { name }, { key: name });
  }

  @OnDomainEvent(POISONED, { consumer: 'ops-test' })
  onPoisoned() {
    throw new NonRetryableMessageError('nobody can handle this');
  }
}

@Module({
  imports: [
    TenantItemsModule,
    BullModule.registerQueue({ name: QUEUE }),
    // The mail queue's name, so the backlog routes find one (no worker here).
    BullModule.registerQueue({ name: 'mail' }),
  ],
  providers: [Poisoner, FailingProcessor, FailingWorkflow],
})
class FixturesModule {}

type Headers = Record<string, string>;

describe('ops (e2e)', () => {
  let app: NestNodeApplication;
  let operator: Headers;
  let outsider: Headers;
  let operatorTenantId: string;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      SharedLocksModule,
      SharedOutboxModule,
      SharedWorkflowsModule,
      FixturesModule,
      OpsModule,
    );
    const db = app.get<Database>(getDrizzleToken());
    let [ops] = await db.select().from(tenants).where(eq(tenants.slug, OPS));
    if (!ops) {
      ops = await app.get(Tenancy).create({ slug: OPS, name: 'Operators' });
      await app
        .get(Tenancy)
        .run(ops.id, () =>
          app
            .get(TransactionHost)
            .withTransaction(() => app.get(RolesService).seedTenantRoles()),
        );
    }
    operatorTenantId = ops.id;
    operator = (await member(app, ops.id, ['administrator'])).headers;
    outsider = (await tenantWithAdmin(app)).admin.headers;
  });
  afterAll(() => app.close());

  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Headers = operator,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  it('is for operators only: a tenant administrator and a guest are refused', async () => {
    const refused = await call('GET', '/v1/ops/queues', outsider);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'operator_required' });
    expect((await call('GET', '/v1/ops/queues', {})).statusCode).toBe(401);
  });

  it('shows a queue and its failed jobs with the reason masked, never a payload', async () => {
    const queue = app.get(Poisoner).queue;
    await queue.add('send', { to: 'someone@example.com' });
    await vi.waitFor(async () => expect(await queue.getFailedCount()).toBe(1), {
      timeout: 10_000,
    });

    const state = (await call('GET', '/v1/ops/queues')).json();
    const found = state.items.find(
      (item: { name: string }) => item.name === QUEUE,
    );
    expect(found).toMatchObject({
      paused: false,
      counts: { failed: 1, waiting: 0 },
    });

    const jobs = await call('GET', `/v1/ops/queues/${QUEUE}/jobs`);
    expect(jobs.statusCode).toBe(200);
    const [job] = jobs.json().items;
    expect(job).toMatchObject({ name: 'send', attempts: 1 });
    expect(job.reason).toContain('upstream refused');
    expect(job.reason).not.toContain('hunter2');
    expect(JSON.stringify(jobs.json())).not.toContain('someone@example.com');

    expect((await call('GET', '/v1/ops/queues/nope/jobs')).statusCode).toBe(
      404,
    );
  });

  it('pauses and resumes a queue and retries its failed jobs, each audited', async () => {
    const queue = app.get(Poisoner).queue;
    const paused = await call('POST', `/v1/ops/queues/${QUEUE}/pause`);
    expect(paused.json()).toEqual({ name: QUEUE, paused: true });
    expect(await queue.isPaused()).toBe(true);
    const resumed = await call('POST', `/v1/ops/queues/${QUEUE}/resume`);
    expect(resumed.json()).toEqual({ name: QUEUE, paused: false });
    expect(await queue.isPaused()).toBe(false);

    const retried = await call('POST', `/v1/ops/queues/${QUEUE}/retry-failed`);
    expect(retried.json()).toEqual({ retried: 1 });

    const db = app.get<Database>(getDrizzleToken());
    const actions = await app
      .get(Tenancy)
      .run(operatorTenantId, async () =>
        (await db.select({ action: auditLog.action }).from(auditLog)).map(
          (row) => row.action,
        ),
      );
    expect(actions).toEqual(
      expect.arrayContaining([
        'ops.queue-paused',
        'ops.queue-resumed',
        'ops.queue-failed-retried',
      ]),
    );
  });

  it('lists, retries and discards dead letters', async () => {
    const tenancy = app.get(Tenancy);
    const { tenantId } = await tenantWithAdmin(app);
    await tenancy.run(tenantId, () => app.get(Poisoner).poison(randomUUID()));
    const letters = app.get(OutboxDeadLetters);
    await vi.waitFor(async () => expect(await letters.list()).toHaveLength(1), {
      timeout: 10_000,
    });

    const listed = (await call('GET', '/v1/ops/dead-letters')).json().items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      topic: 'ops-test.poisoned',
      reason: 'rejected',
    });
    expect(listed[0]).not.toHaveProperty('payload');
    expect((await call('GET', '/v1/ops/outbox')).json()).toMatchObject({
      deadLetters: 1,
    });

    const retried = await call('POST', '/v1/ops/dead-letters/retry', operator, {
      ids: [listed[0].id],
    });
    expect(retried.json()).toEqual({ retried: 1 });
    // The consumer rejects it again: it comes back as a dead letter.
    await vi.waitFor(async () => expect(await letters.list()).toHaveLength(1), {
      timeout: 10_000,
    });

    const discarded = await call(
      'POST',
      '/v1/ops/dead-letters/discard',
      operator,
      {},
    );
    expect(discarded.json()).toEqual({ discarded: 1 });
    expect(await letters.list()).toHaveLength(0);
  });

  it('shows a failed workflow and runs it again', async () => {
    const { id } = await app.get(WorkflowClient).start(FailingWorkflow, {});
    await vi.waitFor(
      async () =>
        expect(
          (await call('GET', `/v1/ops/workflows/${id}`)).json().status,
        ).toBe('failed'),
      { timeout: 10_000 },
    );
    const one = (await call('GET', `/v1/ops/workflows/${id}`)).json();
    expect(one).toMatchObject({
      workflow: 'ops-test-failing',
      error: expect.stringContaining('step failed'),
    });

    const listed = await call('GET', '/v1/ops/workflows?status=failed');
    expect(
      listed.json().items.map((item: { id: string }) => item.id),
    ).toContain(id);

    const again = await call('POST', `/v1/ops/workflows/${id}/retry`);
    expect(again.statusCode).toBe(200);
    expect(
      (await call('POST', `/v1/ops/workflows/${randomUUID()}/retry`))
        .statusCode,
    ).toBe(404);
  });

  it('lists the integrations and tests one, audited; mail without SMTP has no safe test', async () => {
    const overview = (await call('GET', '/v1/ops/diagnostics')).json().items;
    expect(overview).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'database', state: 'ok' }),
        expect.objectContaining({ name: 'redis', state: 'ok' }),
        expect.objectContaining({ name: 'workers', state: 'ok' }),
        expect.objectContaining({
          name: 'mail',
          state: 'configured',
          testable: false,
        }),
      ]),
    );
    const tested = await call('POST', '/v1/ops/diagnostics/redis/test');
    expect(tested.json()).toMatchObject({
      name: 'redis',
      ok: true,
      detail: null,
    });
    expect(
      (await call('POST', '/v1/ops/diagnostics/mail/test')).json(),
    ).toMatchObject({ code: 'not_testable' });
    expect(
      (await call('POST', '/v1/ops/diagnostics/nope/test')).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', '/v1/ops/diagnostics/redis/test', outsider))
        .statusCode,
    ).toBe(403);
  });

  it("counts, retries and discards a tenant's outbox backlog, never mail by tenant", async () => {
    const tenancy = app.get(Tenancy);
    const letters = app.get(OutboxDeadLetters);
    const { tenantId } = await tenantWithAdmin(app);
    await tenancy.run(tenantId, () => app.get(Poisoner).poison(randomUUID()));
    await vi.waitFor(async () => expect(await letters.list()).toHaveLength(1), {
      timeout: 10_000,
    });

    const scope = { tenantId, topic: 'ops-test.poisoned' };
    const preview = await call(
      'POST',
      '/v1/ops/backlog/preview',
      operator,
      scope,
    );
    expect(preview.json().outbox.deadLetters).toMatchObject({
      total: 1,
      groups: [{ topic: 'ops-test.poisoned', count: 1 }],
    });
    // Mail jobs name no tenant: a tenant scope has no mail share.
    expect(preview.json().mail).toBeNull();
    expect(
      (
        await call('POST', '/v1/ops/backlog/preview', operator, {
          global: true,
        })
      ).json().mail,
    ).toMatchObject({ groups: [], capped: false });
    expect(
      (
        await call('POST', '/v1/ops/backlog/preview', operator, {
          tenantId,
          global: true,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', '/v1/ops/backlog/discard', operator, {
          target: 'mail',
          scope,
        })
      ).json(),
    ).toMatchObject({ code: 'mail_not_tenant_scoped' });

    const other = await call('POST', '/v1/ops/backlog/discard', operator, {
      target: 'outbox',
      scope: { tenantId: randomUUID() },
    });
    expect(other.json()).toEqual({ count: 0, more: false });
    expect(await letters.list()).toHaveLength(1);

    const discarded = await call('POST', '/v1/ops/backlog/discard', operator, {
      target: 'outbox',
      scope,
    });
    expect(discarded.json()).toEqual({ count: 1, more: false });
    expect(await letters.list()).toHaveLength(0);
  });
});
