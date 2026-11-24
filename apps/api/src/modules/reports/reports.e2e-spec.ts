import { getQueueToken } from '@nestjs/bullmq';
import { getDrizzleToken } from '@nestjs/drizzle';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import { OutboxRelay } from '@nestjs/outbox';
import type { NestNodeApplication } from '@nestjs/platform-node';
import type { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { MAIL_QUEUE } from '../../core/mail/mail.queue.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { DataTransferModule } from '../data-transfer/data-transfer.module.js';
import { DATA_TRANSFERS } from '../data-transfer/data-transfer.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { ReportsModule } from './reports.module.js';
import { ReportsRunner } from './reports.runner.js';
import { ReportsService } from './reports.service.js';
import { reportSchedules } from './reports.tables.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    OUTBOX_RELAY: 'off',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-reports-${process.pid}-${Date.now()}`,
  });
});

/** The path and query of a signed URL: the tests reach the app without a port. */
const local = (url: string) => {
  const { pathname, search } = new URL(url);
  return pathname + search;
};

/** A link of a mail's HTML, its entities decoded (`&amp;` last). */
const linkOf = (html: string) =>
  /href="([^"]+)"/
    .exec(html)![1]!
    .replace(/&#x3D;/g, '=')
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&');

const paths = (body: { errors?: { path: string }[] }) =>
  (body.errors ?? []).map((error) => error.path);

type Report = { id: string; nextRunAt: string; lastStatus: string | null };

describe('scheduled reports (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  const mailbox = () => app.get(MailTransport) as InMemoryMailTransport;
  const db = () => app.get<Database>(getDrizzleToken());

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      StorageModule,
      ReportsModule,
      testItemsModule({ imports: [DataTransferModule.forRecord(TEST_ITEM)] }),
    );
    team = await recordsTenant(app);
    await createTestItem(app, team.editor.headers, { title: 'Reported' });
  });
  afterAll(async () => {
    for (const name of [DATA_TRANSFERS, MAIL_QUEUE]) {
      await app?.get<Queue>(getQueueToken(name)).obliterate({ force: true });
    }
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    headers: Headers = team.editor.headers,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  const daily = {
    name: 'Daily items',
    exporter: 'test-items',
    format: 'csv',
    timezone: 'Asia/Manila',
    schedule: { every: 'daily', hour: 8 },
  };

  /** Waits until the transfer ended, then delivers its finished event. */
  async function finished(id: string) {
    await vi.waitFor(
      async () =>
        expect(
          (await call('GET', `/v1/data/transfers/${id}`)).json<{
            status: string;
          }>().status,
        ).toMatch(/^(completed|failed)$/),
      { timeout: 15_000, interval: 25 },
    );
    await app.get(OutboxRelay).runOnce();
  }

  const mailTo = (address: string, subject: RegExp) =>
    vi.waitFor(
      () => {
        const mail = mailbox().mails.find(
          (m) =>
            [...m.to, ...m.bcc].some((to) => to.address === address) &&
            subject.test(m.subject),
        );
        expect(mail).toBeDefined();
        return mail!;
      },
      { timeout: 15_000, interval: 25 },
    );

  it('schedules a report in its time zone; only its owner sees or changes it', async () => {
    const before = Date.now();
    const created = await call('POST', '/v1/reports', daily);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: 'Daily items',
      filters: {},
      timezone: 'Asia/Manila',
      recipients: [team.editor.email],
      active: true,
      lastStatus: null,
    });
    const report = created.json<Report>();
    // The next 08:00 in Manila (+08:00): 00:00Z, within a day.
    const next = new Date(report.nextRunAt);
    expect(next.getUTCHours()).toBe(0);
    expect(next.getTime() - before).toBeLessThanOrEqual(86_400_000);

    const mine = (await call('GET', '/v1/reports')).json<{ items: Report[] }>();
    expect(mine.items.map((r) => r.id)).toEqual([report.id]);
    const other = team.other.headers;
    expect(
      (await call('GET', `/v1/reports/${report.id}`, undefined, other))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('PATCH', `/v1/reports/${report.id}`, { name: 'Mine' }, other))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('POST', `/v1/reports/${report.id}/run`, undefined, other))
        .statusCode,
    ).toBe(404);

    // A new schedule computes the next run again: Monday 09:00 Manila.
    const updated = await call('PATCH', `/v1/reports/${report.id}`, {
      schedule: { every: 'weekly', weekday: 1, hour: 9 },
    });
    expect(updated.statusCode).toBe(200);
    const monday = new Date(updated.json<Report>().nextRunAt);
    expect(monday.getUTCDay()).toBe(1);
    expect(monday.getUTCHours()).toBe(1);

    expect((await call('DELETE', `/v1/reports/${report.id}`)).statusCode).toBe(
      204,
    );
    expect((await call('GET', `/v1/reports/${report.id}`)).statusCode).toBe(
      404,
    );
  });

  it('refuses an export the owner may not run, bad filters, zones and schedules', async () => {
    const refused = async (body: object, headers?: Headers) => {
      const response = await call(
        'POST',
        '/v1/reports',
        { ...daily, ...body },
        headers,
      );
      expect(response.statusCode).toBe(400);
      return paths(response.json());
    };
    expect(await refused({ exporter: 'nothing' })).toEqual(['exporter']);
    expect(await refused({ filters: { status: 'nope' } })).toEqual([
      expect.stringMatching(/^filters\./),
    ]);
    expect(await refused({ timezone: 'Mars/Olympus' })).toEqual(['timezone']);
    expect(
      await refused({ schedule: { every: 'monthly', day: 31, hour: 8 } }),
    ).toEqual(['schedule.day']);
    // Who may not read test items may not schedule their export.
    expect(await refused({}, team.nobody.headers)).toEqual(['exporter']);
  });

  it('runs a report now: the recipients get a link that downloads the file', async () => {
    const report = (
      await call('POST', '/v1/reports', {
        ...daily,
        name: 'Now',
        recipients: [team.editor.email, 'boss@example.com'],
      })
    ).json<Report>();
    const run = await call('POST', `/v1/reports/${report.id}/run`);
    expect(run.statusCode).toBe(202);
    const transfer = run.json<{ id: string }>().id;
    await finished(transfer);

    const mail = await mailTo('boss@example.com', /^Report ready: Now$/);
    // The owner is the To; everyone else a Bcc.
    expect(mail.to.map((to) => to.address)).toEqual([team.editor.email]);
    expect(mail.bcc.map((to) => to.address)).toEqual(['boss@example.com']);
    const file = await app.inject({
      method: 'GET',
      url: local(linkOf(mail.html!)),
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toContain('Reported');

    const after = (await call('GET', `/v1/reports/${report.id}`)).json();
    expect(after).toMatchObject({
      lastStatus: 'completed',
      lastTransferId: transfer,
    });
    // Its schedule stays as it was.
    expect(after.nextRunAt).toBe(report.nextRunAt);
  });

  it('starts the due reports once, as their owners, and moves them to their next run', async () => {
    // Only this test's report is due.
    for (const { id } of (await call('GET', '/v1/reports')).json<{
      items: Report[];
    }>().items) {
      await call('PATCH', `/v1/reports/${id}`, { active: false });
    }
    const report = (
      await call('POST', '/v1/reports', {
        ...daily,
        name: 'Scheduled',
        recipients: ['team@example.com'],
      })
    ).json<Report>();
    const due = new Date(report.nextRunAt);
    // A tenant with nothing due is never visited: only the tenants a read across them names.
    const tenancy = app.get(Tenancy);
    const idle = await tenancy.create({ slug: 'idle-reports', name: 'Idle' });
    const visited: string[] = [];
    const reports = app.get(ReportsService);
    const looked = reports.due.bind(reports);
    const spy = vi.spyOn(reports, 'due').mockImplementation((...args) => {
      visited.push(tenancy.tenantId());
      return looked(...args);
    });
    const runner = app.get(ReportsRunner);
    try {
      expect(await runner.run(due)).toBe(1);
      // Claimed: a second pass at the same moment starts nothing, and visits no tenant.
      expect(await runner.run(due)).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(visited).toEqual([team.tenantId]);
    expect(visited).not.toContain(idle.id);

    const [row] = await app
      .get(Tenancy)
      .run(team.tenantId, () =>
        db()
          .select()
          .from(reportSchedules)
          .where(eq(reportSchedules.id, report.id)),
      );
    expect(row!.nextRunAt.getTime()).toBe(due.getTime() + 86_400_000);
    await finished(row!.lastTransferId!);
    await mailTo('team@example.com', /^Report ready: Scheduled$/);
  });
});
