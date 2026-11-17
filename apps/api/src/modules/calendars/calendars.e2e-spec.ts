import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import {
  accessModules,
  member,
  tenantWithAdmin,
} from '../../../test/access.js';
import { bootModules } from '../../../test/boot.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { CalendarsModule } from './calendars.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-calendars-${process.pid}-${Date.now()}`;
});

type Headers = Record<string, string>;

const office = {
  name: 'Support desk',
  timezone: 'America/New_York',
  hours: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    start: '09:00',
    end: '17:00',
  })),
  exceptions: [{ date: '2026-12-25', name: 'Christmas Day' }],
};

describe('business calendars (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;
  let editor: Headers;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), CalendarsModule);
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    admin = tenant.admin.headers;
    editor = (await member(app, tenantId, ['editor'])).headers;
  });
  afterAll(() => app.close());

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
  const audited = (action: string, targetId: string) =>
    app.get(Tenancy).run(tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
        ),
    );
  const make = async (body: object) =>
    (await call('POST', '/v1/calendars', admin, body)).body.id as string;

  it('is managed by those with Access.manageCalendars, read by anyone, audited', async () => {
    expect((await call('POST', '/v1/calendars', editor, office)).status).toBe(
      403,
    );
    const created = await call('POST', '/v1/calendars', admin, office);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ...office, version: 1 });
    const id = created.body.id as string;

    const list = await call('GET', '/v1/calendars', editor);
    expect(list.body.items).toHaveLength(1);
    expect((await call('GET', `/v1/calendars/${id}`, editor)).status).toBe(200);
    expect((await call('DELETE', `/v1/calendars/${id}`, editor)).status).toBe(
      403,
    );
    expect((await call('POST', '/v1/calendars', admin, office)).status).toBe(
      409,
    );
    expect(await audited('businessCalendar.created', id)).toHaveLength(1);

    expect((await call('DELETE', `/v1/calendars/${id}`, admin)).status).toBe(
      204,
    );
    expect(await audited('businessCalendar.deleted', id)).toHaveLength(1);
  });

  it('refuses a bad zone, overlapping spans and a date twice', async () => {
    const bad = await call('POST', '/v1/calendars', admin, {
      ...office,
      name: 'Bad',
      timezone: 'Mars/Base',
      exceptions: [
        { date: '2026-12-25', name: 'A' },
        { date: '2026-12-25', name: 'B' },
      ],
    });
    expect(bad.status).toBe(400);
    expect(paths(bad.body)).toEqual(
      expect.arrayContaining(['timezone', 'exceptions.1.date']),
    );
    const overlap = await call('POST', '/v1/calendars', admin, {
      ...office,
      name: 'Overlap',
      hours: [
        { weekday: 1, start: '09:00', end: '13:00' },
        { weekday: 1, start: '12:00', end: '17:00' },
      ],
    });
    expect(overlap.status).toBe(400);
    expect(paths(overlap.body)).toEqual(['hours']);
  });

  it('raises the version when the hours, zone or exceptions change, not on a rename; audits what changed', async () => {
    const id = await make({ ...office, name: 'Versions' });
    const patch = (payload: object) =>
      call('PATCH', `/v1/calendars/${id}`, admin, payload);
    expect((await patch({ name: 'Help desk' })).body.version).toBe(1);
    expect((await patch({ hours: office.hours })).body.version).toBe(1);
    expect((await patch({ exceptions: [] })).body.version).toBe(2);
    // The same hours changed nothing: only the rename and the exceptions are audited.
    expect(await audited('businessCalendar.updated', id)).toHaveLength(2);
  });

  it('computes a deadline in working time across a daylight-saving change, with the version', async () => {
    const id = await make({ ...office, name: 'Deadlines' });
    const deadline = (from: string) =>
      call('POST', `/v1/calendars/${id}/deadline`, editor, {
        from,
        minutes: 120,
      });
    // Fri 2026-03-06 16:00 EST + 2 h: Monday 2026-03-09 10:00 is EDT.
    expect((await deadline('2026-03-06T21:00:00Z')).body).toEqual({
      due: '2026-03-09T14:00:00.000Z',
      calendarVersion: 1,
    });
    // Christmas Day is closed: Thursday 24th 16:00 EST + 2 h -> Monday 28th 10:00.
    expect((await deadline('2026-12-24T21:00:00Z')).body.due).toBe(
      '2026-12-28T15:00:00.000Z',
    );
    // A change doesn't touch deadlines already computed; asking again gives the new version.
    await call('PATCH', `/v1/calendars/${id}`, admin, { exceptions: [] });
    expect((await deadline('2026-12-24T21:00:00Z')).body).toEqual({
      due: '2026-12-25T15:00:00.000Z',
      calendarVersion: 2,
    });
  });

  it("answers 400 for a calendar with no working time, and is the tenant's own", async () => {
    const id = await make({
      ...office,
      name: 'Closed',
      hours: [],
      exceptions: [],
    });
    const response = await call('POST', `/v1/calendars/${id}/deadline`, admin, {
      from: '2026-03-06T21:00:00Z',
      minutes: 5,
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('calendar_has_no_working_time');

    const other = await tenantWithAdmin(app);
    expect(
      (await call('GET', `/v1/calendars/${id}`, other.admin.headers)).status,
    ).toBe(404);
    expect(
      (await call('GET', '/v1/calendars', other.admin.headers)).body.items,
    ).toEqual([]);
  });
});
