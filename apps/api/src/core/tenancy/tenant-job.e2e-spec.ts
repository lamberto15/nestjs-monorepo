import { BullModule, Processor } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Job, Queue } from 'bullmq';
import { bootModules } from '../../../test/boot.js';
import {
  TenantItemsModule,
  TenantItemsService,
} from '../../../test/fixtures/tenant-items.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueuesModule } from '../queues/queues.module.js';
import { TenancyModule } from './tenancy.module.js';
import { Tenancy } from './tenancy.service.js';
import {
  type TenantEnvelope,
  TenantWorkerHost,
  withTenant,
} from './tenant-job.js';

const QUEUE = 'e2e-tenant-jobs';
const seen: { tenantId: string | null; names: string[] }[] = [];

@Processor(QUEUE)
class ListProcessor extends TenantWorkerHost<object, void> {
  constructor(
    private readonly items: TenantItemsService,
    private readonly tenancy: Tenancy,
  ) {
    super();
  }

  async handle(job: Job<TenantEnvelope>) {
    seen.push({
      tenantId: this.tenancy.current()?.tenantId ?? null,
      names: await this.items.names(),
    });
    expect(job.data.tenantId).toBe(this.tenancy.current()?.tenantId ?? null);
  }
}

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE }), TenantItemsModule],
  providers: [ListProcessor],
})
class JobsModule {}

describe('tenant jobs (e2e)', () => {
  let app: NestNodeApplication;
  let queue: Queue;

  beforeAll(async () => {
    process.env.REDIS_PREFIX = `test-tenant-jobs-${process.pid}`;
    app = await bootModules(
      DatabaseModule,
      TenancyModule,
      QueuesModule,
      JobsModule,
    );
    queue = app.get<Queue>(`BullQueue_${QUEUE}`);
    await queue.obliterate({ force: true });
  });
  afterAll(async () => {
    await app.close();
    delete process.env.REDIS_PREFIX;
  });

  it('runs a job in the tenant that queued it, and refuses one that names none', async () => {
    const tenancy = app.get(Tenancy);
    const items = app.get(TenantItemsService);
    const a = (await tenancy.create({ slug: 'a', name: 'A' })).id;
    const b = (await tenancy.create({ slug: 'b', name: 'B' })).id;
    await tenancy.run(a, () => items.add('a1'));
    await tenancy.run(b, () => items.add('b1'));

    await tenancy.run(a, () => queue.add('list', withTenant({})));
    await queue.add('list', withTenant({}));
    await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 5000 });
    expect(seen).toEqual(
      expect.arrayContaining([
        { tenantId: a, names: ['a1'] },
        { tenantId: null, names: [] },
      ]),
    );

    const bare = await queue.add('list', {}, { attempts: 1 });
    await vi.waitFor(async () => expect(await bare.getState()).toBe('failed'), {
      timeout: 5000,
    });
    expect((await queue.getJob(bare.id!))?.failedReason).toMatch(
      /carries no tenantId/,
    );
    expect(seen).toHaveLength(2);
  });
});
