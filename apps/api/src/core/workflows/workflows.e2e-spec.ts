import { Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import {
  Workflow,
  WorkflowClient,
  type WorkflowContext,
  type WorkflowRunner,
} from '@nestjs/workflows';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import {
  TenantItemsModule,
  TenantItemsService,
} from '../../../test/fixtures/tenant-items.js';
import type { Database } from '../database/database.js';
import { DatabaseModule } from '../database/database.module.js';
import { SharedLocksModule } from '../locks/locks.module.js';
import { Tenancy } from '../tenancy/tenancy.service.js';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { withTenant } from '../tenancy/tenant-job.js';
import { TenantWorkflow } from './tenant-workflow.js';
import { SharedWorkflowsModule } from './workflows.module.js';
import { WorkflowsRetentionJob } from './workflows-retention.job.js';

vi.hoisted(() => {
  process.env.DATA_ENCRYPTION_KEYS =
    'ZmFrZS10ZXN0LWtleS1mb3Itd29ya2Zsb3dzLWUyZS0wMQ';
});

@Workflow('e2e-list-items')
class ListItemsWorkflow extends TenantWorkflow<{ suffix: string }, string[]> {
  constructor(
    private readonly items: TenantItemsService,
    private readonly tenancy: Tenancy,
  ) {
    super();
  }

  async execute(ctx: WorkflowContext, { suffix }: { suffix: string }) {
    await ctx.step('add', () => this.items.add(`from-workflow-${suffix}`));
    // A durable sleep parks the instance: the next step runs on a later execution.
    await ctx.sleep('pause', '100ms');
    return ctx.step('list', async () => [
      this.tenancy.current()?.tenantId ?? 'none',
      ...(await this.items.names()),
    ]);
  }
}

@Workflow('e2e-done')
class DoneWorkflow implements WorkflowRunner<object, number> {
  run(ctx: WorkflowContext) {
    return ctx.step('one', () => Promise.resolve(1));
  }
}

@Workflow('e2e-waits')
class WaitsWorkflow implements WorkflowRunner<object, unknown> {
  run(ctx: WorkflowContext) {
    return ctx.waitForSignal('never', 'e2e.never-sent');
  }
}

@Module({
  imports: [TenantItemsModule],
  providers: [ListItemsWorkflow, DoneWorkflow, WaitsWorkflow],
})
class WorkflowsTestModule {}

describe('workflows (e2e)', () => {
  let app: NestNodeApplication;

  beforeAll(async () => {
    app = await bootModules(
      DatabaseModule,
      TenancyModule,
      SharedLocksModule,
      SharedWorkflowsModule,
      WorkflowsTestModule,
    );
  });
  afterAll(() => app.close());

  it('runs every step in the tenant that started the workflow', async () => {
    const tenancy = app.get(Tenancy);
    const client = app.get(WorkflowClient);
    const a = (await tenancy.create({ slug: 'a', name: 'A' })).id;
    const b = (await tenancy.create({ slug: 'b', name: 'B' })).id;
    await tenancy.run(b, () => app.get(TenantItemsService).add('b-only'));

    const { id } = await tenancy.run(a, () =>
      client.start(ListItemsWorkflow, withTenant({ suffix: '1' })),
    );
    const result = await client.result<string[]>(id, { timeout: '20s' });
    expect(result).toEqual([a, 'from-workflow-1']);

    // DATA_ENCRYPTION_KEYS is set: what the store keeps is not readable.
    const stored = await app
      .get<Database>(getDrizzleToken())
      .execute<{ input: string; output: string }>(
        sql`select input::text as input, output::text as output from nest_workflows.instances where id = ${id}`,
      );
    expect(stored.rows[0]!.input).not.toContain(a);
    expect(stored.rows[0]!.output).not.toContain('from-workflow-1');
  });

  it('purges finished instances past WORKFLOWS_RETENTION_DAYS (14), never an unfinished one', async () => {
    const client = app.get(WorkflowClient);
    const db = app.get<Database>(getDrizzleToken());
    const [old, recent] = [`done-old-${Date.now()}`, `done-new-${Date.now()}`];
    for (const id of [old, recent]) {
      await client.startAndWait(DoneWorkflow, {}, { id }, { timeout: '20s' });
    }
    const waiting = (await client.start(WaitsWorkflow, {})).id;
    for (
      let i = 0;
      (await client.getStatus(waiting))?.status !== 'suspended';
      i++
    ) {
      if (i > 200) throw new Error(`${waiting} never parked`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Finished (or last changed) 15 days ago; `recent` 13 days ago.
    const daysAgo = (days: number) => Date.now() - days * 86_400_000;
    for (const [id, days] of [
      [old, 15],
      [waiting, 15],
      [recent, 13],
    ] as const) {
      await db.execute(
        sql`update nest_workflows.instances set updated_at = ${daysAgo(days)} where id = ${id}`,
      );
    }

    expect((await app.get(WorkflowsRetentionJob).run()).instances).toBe(1);
    expect(await client.getStatus(old)).toBeNull();
    expect((await client.getStatus(recent))?.status).toBe('completed');
    expect((await client.getStatus(waiting))?.status).toBe('suspended');
  });
});
