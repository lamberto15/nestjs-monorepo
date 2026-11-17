import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { Locks, OnOneInstance } from '@nestjs/locks';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../database/database.module.js';
import { SharedLocksModule } from './locks.module.js';

const key = `e2e:${randomUUID()}`;
const runs: string[] = [];

@Injectable()
class TestJob {
  // February 29th at 3 AM: the schedule never fires by itself, the test calls the method.
  @Cron('0 3 29 2 *', { name: key })
  @OnOneInstance({ key })
  async run() {
    runs.push('ran');
    await Promise.resolve();
  }
}

describe('locks and scheduled jobs', () => {
  const apps: TestingModule[] = [];

  async function start() {
    const app = await Test.createTestingModule({
      imports: [DatabaseModule, SharedLocksModule],
      providers: [TestJob],
    }).compile();
    await app.init();
    apps.push(app);
    return app;
  }

  /** Closing hands the job's lease back, so each test starts with none. */
  const stopAll = async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  };

  beforeEach(() => {
    runs.length = 0;
  });

  afterEach(stopAll);

  it('runs the job on one of three instances, and skips the others', async () => {
    const instances = [await start(), await start(), await start()];
    for (const app of instances) {
      await app.get(TestJob).run();
    }
    expect(runs).toEqual(['ran']);
  });

  it('keeps the job on its owner for the next ticks', async () => {
    const instances = [await start(), await start()];
    const tick = async () => {
      for (const app of instances) await app.get(TestJob).run();
    };
    // A lease handed back at shutdown is kept up to a second: wait for the first owner.
    await vi.waitFor(async () => {
      await tick();
      expect(runs).toHaveLength(1);
    });
    await tick();
    await tick();
    expect(runs).toHaveLength(3);
  });

  it('excludes a second holder of a lock until it is released', async () => {
    const [a, b] = [await start(), await start()];
    const name = `${key}:lock`;
    const first = await a.get(Locks).acquire(name);
    expect(first).not.toBeNull();
    expect(await b.get(Locks).acquire(name)).toBeNull();
    await first!.release();
    const second = await b.get(Locks).acquire(name);
    expect(second).not.toBeNull();
    expect(second!.fencingToken).toBeGreaterThan(first!.fencingToken);
    await second!.release();
  });

  it('registers cron jobs where workers run, and none in an api process', async () => {
    const worker = await start();
    expect(worker.get(SchedulerRegistry).getCronJobs().has(key)).toBe(true);

    process.env.APP_ROLE = 'api';
    try {
      const api = await start();
      expect(api.get(SchedulerRegistry).getCronJobs().has(key)).toBe(false);
    } finally {
      delete process.env.APP_ROLE;
    }
  });
});
