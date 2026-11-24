import { getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessModule } from '../../iam/access/access.module.js';
import { AccessService } from '../../iam/access/access.service.js';
import { userRoles } from '../../iam/access/access.tables.js';
import { definePermissions } from '../../iam/access/permissions.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { RECORD_SCHEDULE_JOB } from './recurrence.permissions.js';
import { RecurrenceModule } from './recurrence.module.js';
import {
  RECORD_SCHEDULE_QUEUE,
  RecurrenceService,
} from './recurrence.service.js';
import { recordScheduleRuns, recordSchedules } from './recurrence.tables.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  // No processors: the test runs what is due itself, at the moment it chooses.
  process.env.APP_ROLE = 'api';
  process.env.REDIS_PREFIX = `test-recurrence-${process.pid}-${Date.now()}`;
});

const HOUR = 3_600_000;

type Headers = Record<string, string>;

/** What the module that owns the records provides: where a schedule's rows go. */
const created: { by: string; row: { title: string } }[] = [];
const failWith: { error?: Error } = {};

const ITEM_PERMISSIONS = definePermissions({
  subjects: { ScheduledItem: { actions: { create: [] } } },
  seedRoles: [
    {
      key: 'editor',
      permissions: [
        { subject: 'ScheduledItem', action: 'create', conditions: [] },
      ],
    },
  ],
});

@Module({
  imports: [
    AccessModule.forFeature(ITEM_PERMISSIONS),
    RecurrenceModule.forFeature({
      name: 'items',
      subject: 'ScheduledItem',
      schema: z.object({ title: z.string().min(1) }),
      create: (principal, row) => {
        if (failWith.error) return Promise.reject(failWith.error);
        created.push({
          by: `${principal.kind}:${principal.id}`,
          row: row as { title: string },
        });
        return Promise.resolve();
      },
    }),
  ],
})
class ItemsModule {}

describe('recurring record schedules (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;

  beforeAll(async () => {
    app = await bootModules(
      ...accessModules(),
      QueuesModule,
      RecurrenceModule,
      ItemsModule,
    );
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    admin = tenant.admin.headers;
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    created.length = 0;
    failWith.error = undefined;
    // A run takes every schedule that is due in the tenant: start from none.
    await inTenant(() => db().delete(recordSchedules));
  });

  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(tenantId, work);
  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload && { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body ? (JSON.parse(response.body) as any) : undefined,
    };
  };
  const paths = (body: { errors?: { path: string }[] }) =>
    (body.errors ?? []).map((error) => error.path);
  const editor = async () => (await member(app, tenantId, ['editor'])).headers;

  const daily = {
    name: 'Daily item',
    target: 'items',
    template: { title: 'Stand-up' },
    rrule: 'FREQ=DAILY',
    startDate: '2020-01-01',
    time: '08:00',
    timezone: 'Asia/Manila',
  };
  const schedule = async (headers: Headers, body: object = {}) =>
    (await call('POST', '/v1/record-schedules', headers, { ...daily, ...body }))
      .body;

  const audited = (action: string, targetId: string) =>
    inTenant(() =>
      db()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
        ),
    );
  const state = async (id: string) =>
    (
      await inTenant(() =>
        db().select().from(recordSchedules).where(eq(recordSchedules.id, id)),
      )
    )[0]!;
  /** Runs what is due at `now`, as the worker does; returns the records created. */
  const run = (now: Date) =>
    app
      .get(SystemContext)
      .run(
        RECORD_SCHEDULE_JOB,
        (system) => app.get(RecurrenceService).runTenant(system, now),
        { tenantId, transaction: false },
      );
  /** The moment `ago` ms after the schedule's next occurrence. */
  const due = async (id: string, ago = 0) => {
    const { nextRunAt } = await state(id);
    return { now: new Date(nextRunAt!.getTime() + ago), nextRunAt: nextRunAt! };
  };
  const titled = (title: string) =>
    created.filter((item) => item.row.title === title);

  it('schedules in a time zone with a next-run preview; only the owner sees it', async () => {
    const ada = await editor();
    const bob = await editor();
    const body = await schedule(ada);
    expect(body).toMatchObject({
      status: 'active',
      occurrences: 0,
      maxOccurrences: null,
      failures: 0,
      lastStatus: null,
    });
    // 08:00 in Manila (+08:00) is 00:00Z.
    expect(new Date(body.nextRunAt).getUTCHours()).toBe(0);
    expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    const id = body.id as string;

    const preview = await call('POST', '/v1/record-schedules/preview', ada, {
      rrule: 'FREQ=DAILY;COUNT=2',
      startDate: '2020-01-01',
      time: '08:00',
      timezone: 'Asia/Manila',
      count: 5,
    });
    expect(preview.body.occurrences).toHaveLength(2);
    expect(preview.body.occurrences[0]).toBe(body.nextRunAt);

    for (const [method, url] of [
      ['GET', `/v1/record-schedules/${id}`],
      ['POST', `/v1/record-schedules/${id}/pause`],
      ['DELETE', `/v1/record-schedules/${id}`],
    ] as const) {
      expect((await call(method, url, bob)).status).toBe(404);
    }
    expect(
      (await call('GET', '/v1/record-schedules', ada)).body.items,
    ).toHaveLength(1);
    expect(await audited('recordSchedule.created', id)).toHaveLength(1);
  });

  it('refuses a target or template the owner may not use, and a rule with no occurrence', async () => {
    const ada = await editor();
    const post = (body: object) =>
      call('POST', '/v1/record-schedules', ada, { ...daily, ...body });
    expect(paths((await post({ target: 'nothing' })).body)).toContain('target');
    // A rule the body's schema refuses: before anything else is checked.
    const hourly = await post({ rrule: 'FREQ=HOURLY' });
    expect(hourly.status).toBe(400);
    expect(paths(hourly.body)).toEqual(['rrule']);
    expect(paths((await post({ template: { title: '' } })).body)).toContain(
      'template.title',
    );
    expect(
      paths((await post({ rrule: 'FREQ=DAILY;UNTIL=20200102' })).body),
    ).toEqual(['rrule']);
    // A viewer may not create what the target creates.
    const viewer = (await member(app, tenantId, ['viewer'])).headers;
    expect(
      paths((await call('POST', '/v1/record-schedules', viewer, daily)).body),
    ).toContain('target');
  });

  it('creates the record once, however often or at once it is run', async () => {
    const ada = await member(app, tenantId, ['editor']);
    const { id } = await schedule(ada.headers, {
      template: { title: 'Once' },
    });
    const { now, nextRunAt } = await due(id, HOUR);

    expect(await run(new Date(nextRunAt.getTime() - 1000))).toBe(0);
    expect(await run(now)).toBe(1);
    expect(await run(now)).toBe(0);
    expect(titled('Once')).toEqual([
      { by: `user:${ada.id}`, row: { title: 'Once' } },
    ]);
    const after = await state(id);
    expect(after).toMatchObject({ occurrences: 1, lastStatus: 'created' });
    expect(after.nextRunAt!.getTime() - nextRunAt.getTime()).toBe(24 * HOUR);

    // The same occurrence due again (a reset schedule, a replayed run): no second record.
    await inTenant(() =>
      db()
        .update(recordSchedules)
        .set({ nextRunAt })
        .where(eq(recordSchedules.id, id)),
    );
    await run(now);
    expect(titled('Once')).toHaveLength(1);
    expect((await state(id)).nextRunAt!.getTime() - nextRunAt.getTime()).toBe(
      24 * HOUR,
    );
    const runs = await inTenant(() =>
      db()
        .select()
        .from(recordScheduleRuns)
        .where(eq(recordScheduleRuns.scheduleId, id)),
    );
    expect(runs).toHaveLength(1);
    expect(await audited('recordSchedule.ran', id)).toHaveLength(1);
  });

  it('makes up missed occurrences, oldest first', async () => {
    const { id } = await schedule(await editor(), {
      template: { title: 'Missed' },
    });
    const { now } = await due(id, 3 * 24 * HOUR + HOUR);
    expect(await run(now)).toBe(4);
    expect(titled('Missed')).toHaveLength(4);
    expect((await state(id)).occurrences).toBe(4);
  });

  it('ends after COUNT occurrences', async () => {
    const body = await schedule(await editor(), {
      template: { title: 'Counted' },
      rrule: 'FREQ=DAILY;COUNT=2',
    });
    expect(body.maxOccurrences).toBe(2);
    const { now } = await due(body.id, 5 * 24 * HOUR);
    expect(await run(now)).toBe(2);
    expect(await state(body.id)).toMatchObject({
      status: 'ended',
      endReason: 'completed',
      nextRunAt: null,
      occurrences: 2,
    });
  });

  it('pauses without making up the pause, resumes from now, and ends for good', async () => {
    const ada = await editor();
    const { id } = await schedule(ada, { template: { title: 'Paused' } });
    const { now } = await due(id, 2 * 24 * HOUR);
    const paused = await call('POST', `/v1/record-schedules/${id}/pause`, ada);
    expect(paused.body).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(await run(now)).toBe(0);

    const resumed = await call(
      'POST',
      `/v1/record-schedules/${id}/resume`,
      ada,
    );
    expect(resumed.body.status).toBe('active');
    expect(new Date(resumed.body.nextRunAt).getTime()).toBeGreaterThan(
      Date.now(),
    );
    expect(titled('Paused')).toHaveLength(0);

    const ended = await call('POST', `/v1/record-schedules/${id}/end`, ada);
    expect(ended.body).toMatchObject({ status: 'ended', endReason: 'ended' });
    expect(
      (await call('POST', `/v1/record-schedules/${id}/resume`, ada)).status,
    ).toBe(409);
    expect(
      (await call('PATCH', `/v1/record-schedules/${id}`, ada, { name: 'x' }))
        .status,
    ).toBe(409);
  });

  it('counts failures and skips the occurrence on the third, going on to the next', async () => {
    const { id } = await schedule(await editor(), {
      template: { title: 'Failing' },
    });
    failWith.error = new Error('boom');
    const { now, nextRunAt } = await due(id, HOUR);

    expect(await run(now)).toBe(0);
    expect(await state(id)).toMatchObject({
      failures: 1,
      lastStatus: 'failed',
      lastError: 'boom',
      occurrences: 0,
    });
    expect((await state(id)).nextRunAt).toEqual(nextRunAt);
    await run(now);
    expect((await state(id)).failures).toBe(2);
    await run(now);
    const skipped = await state(id);
    expect(skipped).toMatchObject({ failures: 0, occurrences: 1 });
    expect(skipped.nextRunAt!.getTime() - nextRunAt.getTime()).toBe(24 * HOUR);
    expect(await audited('recordSchedule.skipped', id)).toHaveLength(1);
    expect(titled('Failing')).toHaveLength(0);

    // The target works again: the next occurrence is made.
    failWith.error = undefined;
    expect(await run(new Date(skipped.nextRunAt!.getTime() + 1000))).toBe(1);
    expect(titled('Failing')).toHaveLength(1);
  });

  it("checks the owner's access again: an owner who lost it ends the schedule", async () => {
    const ada = await member(app, tenantId, ['editor']);
    const { id } = await schedule(ada.headers, {
      template: { title: 'Revoked' },
    });
    await inTenant(() =>
      db().delete(userRoles).where(eq(userRoles.userId, ada.id)),
    );
    // The cached abilities of the owner may linger up to a minute: drop them.
    app.get(AccessService).invalidate(tenantId);
    const { now } = await due(id, HOUR);
    expect(await run(now)).toBe(0);
    expect(await state(id)).toMatchObject({
      status: 'ended',
      endReason: 'import_not_allowed',
    });
    expect(
      (await audited('recordSchedule.ended', id))[0]!.details,
    ).toMatchObject({ reason: 'import_not_allowed' });
    expect(created).toHaveLength(0);
  });

  it('moves occurrences into the working time of a business calendar', async () => {
    const ada = await editor();
    const calendar = await call('POST', '/v1/calendars', admin, {
      name: 'Office',
      timezone: 'UTC',
      hours: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '17:00',
      })),
      exceptions: [],
    });
    expect(calendar.status).toBe(201);
    // 2030-01-05 is a Saturday: 03:00 moves to Monday 09:00.
    const body = await schedule(ada, {
      timezone: 'UTC',
      time: '03:00',
      startDate: '2030-01-05',
      calendarId: calendar.body.id,
    });
    expect(body.nextRunAt).toBe('2030-01-07T09:00:00.000Z');
    // The calendar can't go while it is followed.
    const url = `/v1/calendars/${calendar.body.id}`;
    expect((await call('DELETE', url, admin)).status).toBe(409);
    await call('DELETE', `/v1/record-schedules/${body.id}`, ada);
    expect((await call('DELETE', url, admin)).status).toBe(204);
  });

  it('queues one job for a tenant with a schedule due, and none otherwise', async () => {
    const queue = app.get<Queue>(getQueueToken(RECORD_SCHEDULE_QUEUE));
    await queue.obliterate({ force: true });
    const service = app.get(RecurrenceService);
    const { id } = await schedule(await editor(), {
      template: { title: 'Queued' },
    });
    const { now } = await due(id, HOUR);
    expect(await inTenant(() => service.queueIfDue(new Date()))).toBe(false);
    expect(await inTenant(() => service.queueIfDue(now))).toBe(true);
    const [job] = await queue.getWaiting();
    expect(job!.data).toEqual({ tenantId });
  });
});
