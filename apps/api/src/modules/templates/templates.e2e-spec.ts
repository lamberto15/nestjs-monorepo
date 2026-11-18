import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { recordsTenant, testItemModules } from '../../../test/records.js';
import { TemplatesModule } from './templates.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
});

describe('record templates (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      testItemsModule({ imports: [TemplatesModule.forRecord(TEST_ITEM)] }),
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
    call('POST', '/v1/templates', headers, {
      subject: TEST_ITEM.subject,
      ...payload,
    });
  let counter = 0;
  const name = () => `Template ${++counter}-${Date.now()}`;

  it('lists the subjects that opted in, with the fields the caller may set', async () => {
    const response = await call(
      'GET',
      '/v1/templates/subjects',
      team.editor.headers,
    );
    const { items } = response.json<{
      items: { subject: string; fields: string[] }[];
    }>();
    expect(items.map((item) => item.subject)).toEqual(['TestItem']);
    expect(items[0]!.fields).toContain('title');
    // Set by the service, never by a request.
    expect(items[0]!.fields).not.toContain('words');
    // Someone who may not create it sees none.
    const none = await call(
      'GET',
      '/v1/templates/subjects',
      team.viewer.headers,
    );
    expect(none.json()).toEqual({ items: [] });
  });

  it('keeps a template for its owner and previews it as a create body', async () => {
    const created = await save(team.editor.headers, {
      name: name(),
      values: { title: 'Weekly status', status: 'draft' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const preview = await call(
      'GET',
      `/v1/templates/${id}/preview`,
      team.editor.headers,
    );
    expect(preview.json()).toMatchObject({
      values: { title: 'Weekly status', status: 'draft' },
      dropped: [],
    });
    expect(
      (await call('GET', `/v1/templates/${id}`, team.other.headers)).statusCode,
    ).toBe(404);
  });

  it('refuses a value the create would refuse, and a name taken', async () => {
    const response = await save(team.editor.headers, {
      name: name(),
      values: { status: 'nope', words: 3, stray: 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(
      response
        .json<{ errors: { path: string }[] }>()
        .errors.map((e) => e.path)
        .sort(),
    ).toEqual(['values.status', 'values.stray', 'values.words']);
    const label = name();
    expect((await save(team.editor.headers, { name: label })).statusCode).toBe(
      201,
    );
    expect(
      (await save(team.editor.headers, { name: label.toUpperCase() }))
        .statusCode,
    ).toBe(409);
    expect(
      (await save(team.editor.headers, { subject: 'Nothing', name: name() }))
        .statusCode,
    ).toBe(400);
    // Who may not create the subject may not save a template of it.
    expect((await save(team.viewer.headers, { name: name() })).statusCode).toBe(
      403,
    );
  });

  it('shares with the tenant only through Access.manageTemplates', async () => {
    const label = name();
    expect(
      (await save(team.editor.headers, { name: label, visibility: 'tenant' }))
        .statusCode,
    ).toBe(403);
    const shared = await save(team.admin.headers, {
      name: label,
      visibility: 'tenant',
      values: { title: 'Everyone' },
    });
    expect(shared.statusCode).toBe(201);
    const id = shared.json<{ id: string }>().id;
    const seen = await call('GET', `/v1/templates/${id}`, team.other.headers);
    expect(seen.json()).toMatchObject({ mine: false, editable: false });
    expect(
      (await call('DELETE', `/v1/templates/${id}`, team.other.headers))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('DELETE', `/v1/templates/${id}`, team.admin.headers))
        .statusCode,
    ).toBe(204);
  });
});
