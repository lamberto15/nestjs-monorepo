import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Job, Queue } from 'bullmq';
import { QueuesModule } from './queues.module.js';

const QUEUE = 'e2e-jobs';
const handled: string[] = [];

@Processor(QUEUE)
class TestProcessor extends WorkerHost {
  process(job: Job<{ id: string }>) {
    handled.push(job.data.id);
    return Promise.resolve();
  }
}

/** What a feature module does: its own queue, its own processor. */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE })],
  providers: [TestProcessor],
})
class TestJobsModule {}

describe('queues', () => {
  const prefix = `test-queues-${process.pid}`;

  beforeEach(() => {
    handled.length = 0;
    process.env.REDIS_PREFIX = prefix;
  });

  afterEach(() => {
    delete process.env.APP_ROLE;
    delete process.env.WORKER_QUEUES_EXCLUDE;
    delete process.env.REDIS_PREFIX;
  });

  async function start() {
    const moduleRef = await Test.createTestingModule({
      imports: [QueuesModule, TestJobsModule],
    }).compile();
    await moduleRef.init();
    const queue = moduleRef.get<Queue>(`BullQueue_${QUEUE}`);
    await queue.obliterate({ force: true });
    return { moduleRef, queue };
  }

  it("runs a job on the module's own queue, with the shared defaults", async () => {
    process.env.APP_ROLE = 'all';
    const { moduleRef, queue } = await start();
    try {
      const job = await queue.add('work', { id: 'a' });
      expect(job.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
      });
      await vi.waitFor(() => expect(handled).toEqual(['a']), { timeout: 5000 });
      expect(queue.opts.prefix).toBe(`${prefix}:bull`);
    } finally {
      await queue.obliterate({ force: true });
      await moduleRef.close();
    }
  });

  it('only produces in an api process: the processor never runs', async () => {
    process.env.APP_ROLE = 'api';
    const { moduleRef, queue } = await start();
    try {
      await queue.add('work', { id: 'b' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(handled).toEqual([]);
      expect(await queue.getWaitingCount()).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await moduleRef.close();
    }
  });

  it('leaves a queue to another worker when WORKER_QUEUES_EXCLUDE names it', async () => {
    process.env.APP_ROLE = 'worker';
    process.env.WORKER_QUEUES_EXCLUDE = QUEUE;
    const { moduleRef, queue } = await start();
    try {
      await queue.add('work', { id: 'c' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(handled).toEqual([]);
      expect(await queue.getWaitingCount()).toBe(1);
    } finally {
      await queue.obliterate({ force: true });
      await moduleRef.close();
    }
  });
});
