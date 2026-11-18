import { randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../boot.js';
import { recordsTenant, testItemModules } from '../../records.js';
import { MetricsModule } from '../../../src/core/metrics/metrics.module.js';
import { QueuesModule } from '../../../src/core/queues/queues.module.js';
import { SharedWorkflowsModule } from '../../../src/core/workflows/workflows.module.js';
import { SharedHttpClientModule } from '../../../src/core/http-client/http-client.module.js';
import { HoldsModule } from '../../../src/iam/holds/holds.module.js';
import { StorageModule } from '../../../src/modules/storage/storage.module.js';
import { NotificationsModule } from '../../../src/modules/notifications/notifications.module.js';
import { WebhooksModule } from '../../../src/modules/webhooks/webhooks.module.js';
import { RecurrenceModule } from '../../../src/modules/recurrence/recurrence.module.js';
import { RetentionModule } from '../../../src/modules/retention/retention.module.js';
import { AutomationsModule } from '../../../src/modules/automations/automations.module.js';
import { ChoicesModule } from '../../../src/modules/choices/choices.module.js';
import { McpModule } from '../../../src/modules/mcp/mcp.module.js';
import { GeneratedItemsModule } from './generated-items.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    MAIL_TRANSPORT: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    STORAGE_DRIVER: 'memory',
    WEB_URL: 'https://web.example.com',
    WEBHOOKS_WORKER: 'off',
    WEBHOOKS_ALLOW_LOOPBACK: 'on',
    REDIS_PREFIX: `test-generated-items-${process.pid}-${Date.now()}`,
  });
});

/** Generated items (generated): the routes of the record, and one check of each add-on it imports. */
describe('generated-items (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      MetricsModule,
      QueuesModule,
      SharedWorkflowsModule,
      SharedHttpClientModule,
      HoldsModule,
      StorageModule,
      NotificationsModule,
      WebhooksModule,
      RecurrenceModule,
      RetentionModule,
      AutomationsModule,
      ChoicesModule,
      McpModule,
      GeneratedItemsModule,
    );
    team = await recordsTenant(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });

  /** A valid create body. */
  const sample = () => ({
    title: 'Title',
    body: 'Some words',
    status: 'draft',
    amount: { amount: '12.50', currency: 'EUR' },
    dueOn: '2026-01-31',
    code: `Code ${randomUUID().slice(0, 8)}`,
  });

  /** One of the editor's, as answered: 201 or the test fails. */
  const create = async (body: object = {}) => {
    const response = await call(
      'POST',
      '/v1/generated-items',
      team.editor.headers,
      { ...sample(), ...body },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<Record<string, unknown> & { id: string }>();
  };

  it('creates one as its owner, reads it with an ETag and lists it', async () => {
    const item = await create();
    expect(item.ownerId).toBe(`user:${team.editor.id}`);
    const read = await call(
      'GET',
      `/v1/generated-items/${item.id}`,
      team.editor.headers,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(read.headers.etag).toBeTruthy();
    const page = await call('GET', '/v1/generated-items', team.editor.headers);
    expect(page.json().items.map((row: { id: string }) => row.id)).toContain(
      item.id,
    );
  });

  it('refuses a body its schema refuses (400)', async () => {
    const response = await call(
      'POST',
      '/v1/generated-items',
      team.editor.headers,
      { ...sample(), title: 12345 },
    );
    expect(response.statusCode, response.body).toBe(400);
  });

  it('changes only what is sent, and refuses a stale If-Match (412)', async () => {
    const item = await create();
    const changed = await call(
      'PATCH',
      `/v1/generated-items/${item.id}`,
      team.editor.headers,
      { title: 'Changed' },
    );
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().title).toEqual('Changed');
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/generated-items/${item.id}`,
      headers: { ...team.editor.headers, 'if-match': '"stale"' },
      payload: {},
    });
    expect(stale.statusCode, stale.body).toBe(412);
  });

  it('deletes one to the recycle bin, and restores it', async () => {
    const item = await create();
    const deleted = await call(
      'DELETE',
      `/v1/generated-items/${item.id}`,
      team.editor.headers,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(
      (await call('GET', `/v1/generated-items/${item.id}`, team.editor.headers))
        .statusCode,
    ).toBe(404);
    const restored = await call(
      'POST',
      `/v1/generated-items/${item.id}/restore`,
      team.editor.headers,
    );
    expect(restored.statusCode, restored.body).toBeLessThan(300);
    expect(
      (await call('GET', `/v1/generated-items/${item.id}`, team.editor.headers))
        .statusCode,
    ).toBe(200);
  });

  it('hides it from a member without a role (404); a viewer reads it but may not change it (403)', async () => {
    const item = await create();
    expect(
      (await call('GET', `/v1/generated-items/${item.id}`, team.nobody.headers))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/v1/generated-items/${item.id}`, team.viewer.headers))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          'PATCH',
          `/v1/generated-items/${item.id}`,
          team.viewer.headers,
          {},
        )
      ).statusCode,
    ).toBe(403);
  });

  it('tags: a tag set on one is shown with it', async () => {
    const item = await create();
    const tag = await call('POST', '/v1/tags', team.admin.headers, {
      subject: 'GeneratedItem',
      name: 'Urgent',
    });
    expect(tag.statusCode, tag.body).toBe(201);
    const set = await call(
      'PUT',
      `/v1/generated-items/${item.id}/tags`,
      team.editor.headers,
      { tagIds: [tag.json().id] },
    );
    expect(set.statusCode, set.body).toBe(200);
    const read = await call(
      'GET',
      `/v1/generated-items/${item.id}`,
      team.editor.headers,
    );
    expect(read.json().tags).toHaveLength(1);
  });

  it('comments: one is added and listed', async () => {
    const item = await create();
    const added = await call(
      'POST',
      `/v1/generated-items/${item.id}/comments`,
      team.editor.headers,
      { body: 'A first comment' },
    );
    expect(added.statusCode, added.body).toBe(201);
    const listed = await call(
      'GET',
      `/v1/generated-items/${item.id}/comments`,
      team.editor.headers,
    );
    expect(listed.json().items).toHaveLength(1);
  });

  it('attachments: a record lists its files', async () => {
    const item = await create();
    const files = await call(
      'GET',
      `/v1/generated-items/${item.id}/attachments`,
      team.editor.headers,
    );
    expect(files.statusCode, files.body).toBe(200);
    expect(files.json().items).toEqual([]);
  });

  it('revisions: a new record has its first revision', async () => {
    const item = await create();
    const revisions = await call(
      'GET',
      `/v1/generated-items/${item.id}/revisions`,
      team.editor.headers,
    );
    expect(revisions.statusCode, revisions.body).toBe(200);
    expect(revisions.json().items).toHaveLength(1);
  });

  it('favorites: a record is pinned', async () => {
    const item = await create();
    const pinned = await call('POST', '/v1/favorites', team.editor.headers, {
      kind: 'record',
      subject: 'GeneratedItem',
      target: item.id,
      label: 'Pinned',
    });
    expect(pinned.statusCode, pinned.body).toBe(201);
  });

  it('recents: an opened record is noted', async () => {
    const item = await create();
    const noted = await call('POST', '/v1/recents', team.editor.headers, {
      subject: 'GeneratedItem',
      recordId: item.id,
      label: 'Opened',
    });
    expect(noted.statusCode, noted.body).toBeLessThan(300);
  });

  it('templates: the record takes templates', async () => {
    const subjects = await call(
      'GET',
      '/v1/templates/subjects',
      team.editor.headers,
    );
    expect(subjects.statusCode, subjects.body).toBe(200);
    expect(subjects.body).toContain('GeneratedItem');
  });

  it('choices: its status offers its choices', async () => {
    const options = await call(
      'GET',
      '/v1/choices/generated-item-status/status/options',
      team.editor.headers,
    );
    expect(options.statusCode, options.body).toBe(200);
  });

  it('custom fields: a record shows its custom values', async () => {
    const item = await create();
    expect(item.custom).toEqual({});
  });

  it('computed fields: shown with the record', async () => {
    const item = await create();
    expect(item.titleLength).toBe(String(item.title).length);
  });

  it('approvals: publish runs at once while its approval is off', async () => {
    const item = await create();
    const asked = await call(
      'POST',
      `/v1/generated-items/${item.id}/publish`,
      team.editor.headers,
      {},
    );
    expect(asked.statusCode, asked.body).toBe(200);
    expect(asked.json()).toMatchObject({ status: 'applied' });
  });

  it('acknowledgments: a record has its dashboard', async () => {
    const item = await create();
    const dashboard = await call(
      'GET',
      `/v1/generated-items/${item.id}/acknowledgments`,
      team.editor.headers,
    );
    expect(dashboard.statusCode, dashboard.body).toBe(200);
  });

  it('bulk: deletes the records sent', async () => {
    const item = await create();
    const run = await call(
      'POST',
      '/v1/generated-items/bulk',
      team.editor.headers,
      { action: 'delete', ids: [item.id] },
    );
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({ done: 1 });
  });

  it('merge: a record lists its likely duplicates', async () => {
    const item = await create();
    const duplicates = await call(
      'GET',
      `/v1/generated-items/${item.id}/duplicates`,
      team.editor.headers,
    );
    expect(duplicates.statusCode, duplicates.body).toBe(200);
    expect(duplicates.json().items).toBeInstanceOf(Array);
  });

  it('data transfer: gives the file to fill for an import', async () => {
    const template = await call(
      'GET',
      '/v1/data/imports/generated-items/template',
      team.editor.headers,
    );
    expect(template.statusCode, template.body).toBe(200);
  });

  it('data quality: a record has its findings', async () => {
    const item = await create();
    const findings = await call(
      'GET',
      `/v1/generated-items/${item.id}/data-quality`,
      team.admin.headers,
    );
    expect(findings.statusCode, findings.body).toBe(200);
  });

  it('shares: a link to a record is made', async () => {
    const item = await create();
    const share = await call(
      'POST',
      `/v1/generated-items/${item.id}/shares`,
      team.editor.headers,
      {
        fields: ['title'],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    );
    expect(share.statusCode, share.body).toBe(201);
  });

  it('documents: a record lists its PDFs', async () => {
    const item = await create();
    const documents = await call(
      'GET',
      `/v1/generated-items/${item.id}/documents`,
      team.editor.headers,
    );
    expect(documents.statusCode, documents.body).toBe(200);
  });

  it('ai: a run is refused while no model is set up (ANTHROPIC_API_KEY)', async () => {
    const item = await create();
    const run = await call('POST', '/v1/ai/runs', team.editor.headers, {
      source: 'generated-items',
      recordId: item.id,
      task: 'summarize',
    });
    expect(run.statusCode, run.body).toBe(503);
  });

  it('automations: the record takes rules', async () => {
    const list = await call(
      'GET',
      '/v1/lists/GeneratedItem',
      team.editor.headers,
    );
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().capabilities).toMatchObject({ automations: true });
  });

  it('sequences: a new record has its number', async () => {
    const item = await create();
    expect(item.number).toMatch(/\d{5}$/);
  });

  it('webhooks: its changes are event types', async () => {
    const types = await call(
      'GET',
      '/v1/webhook-event-types',
      team.editor.headers,
    );
    expect(types.statusCode, types.body).toBe(200);
    expect(types.body).toContain('generatedItem.created');
  });

  it('notifications: a record is watched', async () => {
    const item = await create();
    const watched = await call(
      'POST',
      `/v1/generated-items/${item.id}/watch`,
      team.editor.headers,
    );
    expect(watched.statusCode, watched.body).toBeLessThan(300);
  });

  it('recurrence: a schedule of records is made', async () => {
    const schedule = await call(
      'POST',
      '/v1/record-schedules',
      team.editor.headers,
      {
        name: 'Daily',
        target: 'generated-items',
        template: sample(),
        rrule: 'FREQ=DAILY',
        startDate: '2020-01-01',
        time: '08:00',
      },
    );
    expect(schedule.statusCode, schedule.body).toBe(201);
  });

  it('retention: the record has a rule', async () => {
    const rules = await call('GET', '/v1/retention/rules', team.admin.headers);
    expect(rules.statusCode, rules.body).toBe(200);
    expect(rules.body).toContain('"generated-items"');
  });

  it('mcp: its record tools are listed', async () => {
    const listed = await call(
      'POST',
      '/v1/mcp',
      {
        ...team.editor.headers,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain('"generated-items_create"');
  });
});
