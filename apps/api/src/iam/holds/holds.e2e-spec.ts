import { randomUUID } from 'node:crypto';
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
import { auditLog } from '../audit/audit.tables.js';
import { HoldsModule } from './holds.module.js';
import { LegalHoldsService } from './holds.service.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.REDIS_PREFIX = `test-holds-${process.pid}-${Date.now()}`;
});

type Headers = Record<string, string>;

describe('legal holds (e2e)', () => {
  let app: NestNodeApplication;
  let tenantId: string;
  let admin: Headers;
  let editor: Headers;

  beforeAll(async () => {
    app = await bootModules(...accessModules(), HoldsModule);
    const tenant = await tenantWithAdmin(app);
    tenantId = tenant.tenantId;
    admin = tenant.admin.headers;
    editor = (await member(app, tenantId, ['editor'])).headers;
  });
  afterAll(() => app.close());

  const call = (
    method: 'GET' | 'POST',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const place = (body: object) => call('POST', '/v1/legal-holds', admin, body);
  const release = (id: string, body: object = {}) =>
    call('POST', `/v1/legal-holds/${id}/release`, admin, body);
  const entries = (action: string, targetId: string) =>
    app.get(Tenancy).run(tenantId, () =>
      app
        .get<Database>(getDrizzleToken())
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)),
        ),
    );
  /** What a delete's transaction asks, in the tenant. */
  const assertNotHeld = (subject: string, ids: string[]) =>
    app
      .get(Tenancy)
      .run(tenantId, () =>
        app.get(LegalHoldsService).assertNotHeld(subject, ids),
      );

  it('lets only hold managers place, list and release them', async () => {
    const body = { subject: 'Widget', reason: 'Case 1' };
    expect(
      (await call('POST', '/v1/legal-holds', editor, body)).statusCode,
    ).toBe(403);
    expect((await call('GET', '/v1/legal-holds', editor)).statusCode).toBe(403);

    const placed = await place({ ...body, recordId: randomUUID() });
    expect(placed.statusCode).toBe(201);
    const hold = placed.json();
    expect(hold).toMatchObject({
      subject: 'Widget',
      active: true,
      reason: 'Case 1',
      releasedAt: null,
    });
    expect(
      (await call('POST', `/v1/legal-holds/${hold.id}/release`, editor, {}))
        .statusCode,
    ).toBe(403);

    const invalid = await place({ subject: 'widget', reason: 'x' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('validation_failed');
    expect((await place({ subject: 'Widget', reason: '' })).statusCode).toBe(
      400,
    );

    const released = await release(hold.id, { note: 'Settled' });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({
      active: false,
      releaseNote: 'Settled',
    });
    expect((await release(hold.id)).statusCode).toBe(409);
    expect((await release(randomUUID())).statusCode).toBe(404);

    const active = await call(
      'GET',
      '/v1/legal-holds?active=true&subject=Widget',
      admin,
    );
    expect(active.json().items).toEqual([]);
    const all = await call('GET', `/v1/legal-holds/${hold.id}`, admin);
    expect(all.json()).toMatchObject({ id: hold.id, active: false });

    expect(await entries('legal-hold.placed', hold.id)).toHaveLength(1);
    expect(await entries('legal-hold.released', hold.id)).toHaveLength(1);
  });

  it('refuses to delete a held record, or any of a held subject, until released', async () => {
    const held = randomUUID();
    const other = randomUUID();
    const one = (
      await place({ subject: 'Gadget', recordId: held, reason: 'Case 2' })
    ).json();

    await expect(assertNotHeld('Gadget', [held, other])).rejects.toMatchObject({
      response: { code: 'legal_hold' },
    });
    await assertNotHeld('Gadget', [other]);
    // Another subject's record with the same id is not held.
    await assertNotHeld('Widget', [held]);

    // A hold on the whole subject covers records made after it.
    const wide = (await place({ subject: 'Gadget', reason: 'Audit' })).json();
    await expect(assertNotHeld('Gadget', [randomUUID()])).rejects.toMatchObject(
      { response: { code: 'legal_hold' } },
    );

    await release(one.id);
    await release(wide.id);
    await assertNotHeld('Gadget', [held, other]);
  });

  it('keeps one tenant’s holds from another', async () => {
    const record = randomUUID();
    await place({ subject: 'Sprocket', recordId: record, reason: 'Case 3' });
    const other = await tenantWithAdmin(app);
    const seen = await call(
      'GET',
      '/v1/legal-holds?subject=Sprocket',
      other.admin.headers,
    );
    expect(seen.json().items).toEqual([]);
    await app
      .get(Tenancy)
      .run(other.tenantId, () =>
        app.get(LegalHoldsService).assertNotHeld('Sprocket', [record]),
      );
  });
});
