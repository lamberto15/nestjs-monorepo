import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  recordsTenant,
  testItemModules,
  unitWithLead,
} from '../../../test/records.js';
import { ViewsModule } from './views.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
});

describe('saved views (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      testItemsModule(),
      ViewsModule,
    );
    team = await recordsTenant(app);
  });
  afterAll(() => app.close());

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const save = (headers: Record<string, string>, payload: object) =>
    call('POST', '/v1/views', headers, {
      subject: TEST_ITEM.subject,
      ...payload,
    });
  let counter = 0;
  const name = () => `View ${++counter}-${Date.now()}`;

  it('keeps a private view for its owner alone', async () => {
    const label = name();
    const created = await save(team.editor.headers, {
      name: label,
      query: { status: 'draft', sort: '-createdAt' },
      columns: ['title', 'status'],
    });
    expect(created.statusCode).toBe(201);
    const view = created.json<{
      id: string;
      mine: boolean;
      editable: boolean;
    }>();
    expect(view).toMatchObject({ mine: true, editable: true });

    const mine = await call('GET', '/v1/views', team.editor.headers);
    expect(
      mine.json<{ items: { id: string }[] }>().items.map((v) => v.id),
    ).toContain(view.id);
    const theirs = await call('GET', '/v1/views', team.other.headers);
    expect(
      theirs.json<{ items: { id: string }[] }>().items.map((v) => v.id),
    ).not.toContain(view.id);
    expect(
      (await call('GET', `/v1/views/${view.id}`, team.other.headers))
        .statusCode,
    ).toBe(404);
    // A name is unique per place, whatever its case.
    const again = await save(team.editor.headers, {
      name: label.toUpperCase(),
    });
    expect(again.statusCode).toBe(409);
    // Another owner may use it.
    expect((await save(team.other.headers, { name: label })).statusCode).toBe(
      201,
    );
  });

  it('applies a view as the list route takes it, columns included', async () => {
    const created = await save(team.editor.headers, {
      name: name(),
      query: { status: 'draft' },
      columns: ['title', 'status'],
    });
    const applied = await call(
      'GET',
      `/v1/views/${created.json<{ id: string }>().id}/apply`,
      team.editor.headers,
    );
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      params: { status: 'draft', fields: 'title,status' },
      columns: ['title', 'status'],
      hiddenColumns: [],
    });
  });

  it('refuses what the list would refuse', async () => {
    const bad = async (payload: object) => {
      const response = await save(team.editor.headers, {
        name: name(),
        ...payload,
      });
      return {
        status: response.statusCode,
        paths: (
          response.json<{ errors?: { path: string }[] }>().errors ?? []
        ).map((e) => e.path),
      };
    };
    expect(await bad({ subject: 'Nothing' })).toEqual({
      status: 400,
      paths: ['subject'],
    });
    expect(await bad({ query: { limit: '5' } })).toEqual({
      status: 400,
      paths: ['query.limit'],
    });
    expect(await bad({ query: { nope: 'x' } })).toEqual({
      status: 400,
      paths: ['query.nope'],
    });
    expect(await bad({ columns: ['nope'] })).toEqual({
      status: 400,
      paths: ['columns'],
    });
    // Someone who may not read the list may not save a view of it.
    const forbidden = await save(team.nobody.headers, { name: name() });
    expect(forbidden.statusCode).toBe(403);
  });

  it('shares with the tenant only through Access.manageViews', async () => {
    const label = name();
    expect(
      (await save(team.editor.headers, { name: label, visibility: 'tenant' }))
        .statusCode,
    ).toBe(403);
    const shared = await save(team.admin.headers, {
      name: label,
      visibility: 'tenant',
    });
    expect(shared.statusCode).toBe(201);
    const id = shared.json<{ id: string }>().id;
    // Everyone who reads the list sees it; they cannot change it.
    const seen = await call('GET', `/v1/views/${id}`, team.viewer.headers);
    expect(seen.json()).toMatchObject({ mine: false, editable: false });
    expect(
      (
        await call('PATCH', `/v1/views/${id}`, team.viewer.headers, {
          name: 'x',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `/v1/views/${id}`, team.admin.headers)).statusCode,
    ).toBe(204);
  });

  it("shares with a unit's members, and only members share with it", async () => {
    const { unitId, worker } = await unitWithLead(app, team);
    const label = name();
    // The editor of another place is no member of the unit.
    expect(
      (
        await save(team.editor.headers, {
          name: label,
          visibility: 'unit',
          unitId,
        })
      ).statusCode,
    ).toBe(403);
    const created = await save(worker.headers, {
      name: label,
      visibility: 'unit',
      unitId,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect(
      (await call('GET', `/v1/views/${id}`, team.editor.headers)).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/views/${id}`, worker.headers)).statusCode,
    ).toBe(200);
    // Back to private: only its owner.
    const priv = await call('PATCH', `/v1/views/${id}`, worker.headers, {
      visibility: 'private',
    });
    expect(priv.json()).toMatchObject({ visibility: 'private', unitId: null });
  });
});
