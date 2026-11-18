import { randomUUID } from 'node:crypto';
import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { tenantWithAdmin } from '../../../test/access.js';
import { apiClient, signIn } from '../../../test/auth.js';
import { bootModules } from '../../../test/boot.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import {
  MARKS_BODY,
  MARKS_RESPONSE,
} from '../../../test/fixtures/test-items/marks/marks.schemas.js';
import { TestMarksModule } from '../../../test/fixtures/test-items/marks/marks.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import type { Database } from '../../core/database/database.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { FeaturesModule } from '../features/features.module.js';
import { ModeModule } from '../mode/mode.module.js';
import { ModeService } from '../mode/mode.service.js';
import { McpModule } from './mcp.module.js';

vi.hoisted(() => {
  process.env.SCHEDULER = 'off';
  process.env.IDEMPOTENCY = 'optional';
  process.env.REDIS_PREFIX = `test-mcp-${process.pid}:`;
});

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
}

/**
 * The MCP server (modules/mcp) on the test items: JSON-RPC over the
 * Streamable HTTP endpoint, as a client of the 2025 revisions sends it
 * (`initialize`, then each request on its own: the server keeps no session).
 */
describe('mcp (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      MetricsModule,
      ModeModule,
      FeaturesModule,
      // One add-on (marks), whose body key the write tools must take.
      testItemsModule({
        imports: [
          TestMarksModule.forRecord(TEST_ITEM),
          McpModule.forRecord(TEST_ITEM),
        ],
        response: MARKS_RESPONSE,
        body: MARKS_BODY,
      }),
      McpModule,
    );
    team = await recordsTenant(app);
  });

  afterAll(async () => {
    await app?.close();
  });

  /** One JSON-RPC request; the answer read from JSON or from the event stream. */
  const rpc = async (
    headers: Headers,
    method: string,
    params?: Record<string, unknown>,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        ...headers,
      },
      payload: { jsonrpc: '2.0', id: 1, method, ...(params && { params }) },
    });
    const text = response.body;
    const data = String(response.headers['content-type']).startsWith(
      'text/event-stream',
    )
      ? text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .at(-1)
      : text;
    return {
      status: response.statusCode,
      body: (data ? JSON.parse(data) : undefined) as {
        result?: Record<string, unknown>;
        error?: { code: number; message: string };
        code?: string;
      },
    };
  };

  /** A tool's result: its JSON text parsed, and whether it is an error. */
  const call = async (
    member: { headers: Headers },
    name: string,
    args: Record<string, unknown> = {},
  ) => {
    const { status, body } = await rpc(member.headers, 'tools/call', {
      name,
      arguments: args,
    });
    expect(status).toBe(200);
    const result = body.result as unknown as ToolResult;
    const text = result.content[0]?.text ?? '';
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {
      // Text, as the SDK's own refusals (the input schema's) are.
    }
    return { isError: result.isError === true, value: value as any, text };
  };

  const db = () => app.get<Database>(getDrizzleToken());
  const audited = (id: string) =>
    app.get(Tenancy).run(team.tenantId, () =>
      db()
        .select({ action: auditLog.action, actor: auditLog.actor })
        .from(auditLog)
        .where(and(eq(auditLog.targetId, id)))
        .orderBy(auditLog.at),
    );

  it('answers initialize with the server and its tools capability', async () => {
    const { status, body } = await rpc(team.editor.headers, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0.0.0' },
    });
    expect(status).toBe(200);
    expect(body.result).toMatchObject({
      serverInfo: { name: 'api' },
      capabilities: { tools: {} },
    });
  });

  it('refuses a request without credentials, with the session cookie, or with a bad key', async () => {
    expect((await rpc({}, 'tools/list')).status).toBe(401);
    const editorSession = await signIn(app, team.editor.email);
    const cookieOnly = await rpc(editorSession.headers, 'tools/list');
    expect(cookieOnly.status).toBe(401);
    expect(cookieOnly.body.code).toBe('mcp_bearer_required');
    // The cookie next to a bearer: still refused, so a call is never the cookie's.
    const both = await rpc(
      { ...team.editor.headers, ...editorSession.headers },
      'tools/list',
    );
    expect(both.body.code).toBe('mcp_bearer_required');
    expect(
      (await rpc({ authorization: 'Bearer nope' }, 'tools/list')).status,
    ).toBe(401);
  });

  it('runs the guards of every route: a break-glass header is refused', async () => {
    const { status, body } = await rpc(
      { ...team.editor.headers, 'break-glass': randomUUID() },
      'tools/list',
    );
    expect(status).toBe(403);
    expect(body.code).toBe('break_glass_invalid');
  });

  it('lists the tools, with the record schemas as their arguments', async () => {
    const { body } = await rpc(team.editor.headers, 'tools/list');
    const tools = (
      body.result as {
        tools: { name: string; inputSchema: { properties?: object } }[];
      }
    ).tools;
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining([
        'whoami',
        'describe_list',
        'search',
        'test-items_list',
        'test-items_get',
        'test-items_create',
        'test-items_update',
        'test-items_delete',
      ]),
    );
    expect(
      Object.keys(byName.get('test-items_create')!.inputSchema.properties!),
    ).toEqual(
      expect.arrayContaining([
        'title',
        'status',
        'parentId',
        'marks', // the add-on's body key, from the feature's schemas
        'idempotencyKey', // optional: IDEMPOTENCY=optional here
      ]),
    );
    expect(byName.get('test-items_create')!.inputSchema).not.toMatchObject({
      required: expect.arrayContaining(['idempotencyKey']),
    });
    expect(
      Object.keys(
        (
          byName.get('test-items_update')!.inputSchema.properties as {
            changes: { properties: object };
          }
        ).changes.properties,
      ),
    ).toEqual(expect.arrayContaining(['title', 'marks']));
    expect(
      byName.get('test-items_create')!.inputSchema.properties,
    ).not.toHaveProperty('words');
    expect(
      Object.keys(byName.get('test-items_list')!.inputSchema.properties!),
    ).toEqual(
      expect.arrayContaining(['q', 'sort', 'limit', 'cursor', 'status']),
    );
    // The package lists every tool to every principal: a call decides.
    const { body: nobodys } = await rpc(team.nobody.headers, 'tools/list');
    expect((nobodys.result as { tools: unknown[] }).tools.length).toBe(
      tools.length,
    );
  });

  it('tells who the caller is, in which tenant, and what they may do', async () => {
    const { isError, value } = await call(team.editor, 'whoami');
    expect(isError).toBe(false);
    expect(value).toMatchObject({
      principal: { kind: 'user', id: team.editor.id },
      tenantId: team.tenantId,
    });
    expect(value.permissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: 'TestItem', action: 'create' }),
      ]),
    );
    const client = await apiClient(app, team.tenantId);
    expect((await call(client, 'whoami')).value.principal).toEqual({
      kind: 'client',
      id: client.client.id,
      name: client.client.name,
    });
  });

  it('describes a list to whoever may read it', async () => {
    const { value } = await call(team.viewer, 'describe_list', {
      subject: 'TestItem',
    });
    expect(value).toHaveProperty('fields');
    const refused = await call(team.nobody, 'describe_list', {
      subject: 'TestItem',
    });
    expect(refused).toMatchObject({
      isError: true,
      value: { status: 403, code: 'forbidden' },
    });
    expect(
      (await call(team.viewer, 'describe_list', { subject: 'Nope' })).value,
    ).toMatchObject({ status: 404 });
  });

  it('creates a record as the HTTP route does: owner, derived field, add-on keys, audit', async () => {
    const { isError, value: created } = await call(
      team.editor,
      'test-items_create',
      {
        title: 'From an agent',
        body: 'three words here',
        words: 99,
        marks: ['agent'],
      },
    );
    expect(isError).toBe(false);
    expect(created.etag).toMatch(/^"[\w-]+"$/);
    const value = created.record;
    expect(value).toMatchObject({
      marks: ['agent'],
      title: 'From an agent',
      ownerId: `user:${team.editor.id}`,
      words: 3,
      status: 'draft',
    });
    expect(value).not.toHaveProperty('tenantId');
    expect(value).not.toHaveProperty('search');
    expect(await audited(value.id)).toEqual([
      { action: 'testItem.created', actor: `user:${team.editor.id}` },
    ]);
  });

  it('refuses a create without the permission, and arguments the schema refuses', async () => {
    expect(
      (await call(team.nobody, 'test-items_create', { title: 'No' })).value,
    ).toMatchObject({ status: 403, code: 'forbidden' });
    const invalid = await call(team.editor, 'test-items_create', {
      status: 'archived',
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain('Input validation error');
  });

  it('replays a create retried with its idempotency key, and refuses the key with other arguments', async () => {
    const idempotencyKey = randomUUID();
    const first = await call(team.editor, 'test-items_create', {
      title: 'Once',
      idempotencyKey,
    });
    const again = await call(team.editor, 'test-items_create', {
      idempotencyKey,
      title: 'Once',
    });
    expect(again.value.record.id).toBe(first.value.record.id);
    expect(await audited(first.value.record.id)).toHaveLength(1);
    expect(
      (
        await call(team.editor, 'test-items_create', {
          title: 'Twice',
          idempotencyKey,
        })
      ).value,
    ).toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
    // Another caller's key is theirs: the same key creates their own.
    const others = await call(team.other, 'test-items_create', {
      title: 'Once',
      idempotencyKey,
    });
    expect(others.value.record.id).not.toBe(first.value.record.id);
    // A refused run frees the key: the retry runs again.
    const refusedKey = randomUUID();
    expect(
      (
        await call(team.nobody, 'test-items_create', {
          title: 'No',
          idempotencyKey: refusedKey,
        })
      ).value,
    ).toMatchObject({ status: 403 });
  });

  it("gets a record the caller may read, with its etag; another tenant's id is a 404", async () => {
    const item = await createTestItem(app, team.editor.headers);
    const read = await call(team.viewer, 'test-items_get', { id: item.id });
    expect(read.value.record).toMatchObject({ id: item.id, title: item.title });
    // The ETag GET /v1/test-items/{id} sends.
    const http = await app.inject({
      method: 'GET',
      url: `/v1/test-items/${item.id}`,
      headers: team.viewer.headers,
    });
    expect(read.value.etag).toBe(http.headers.etag);
    expect(
      (await call(team.other, 'test-items_get', { id: item.id })).value,
    ).toMatchObject({ status: 404, code: 'not_found' });
    const elsewhere = await tenantWithAdmin(app);
    expect(
      (await call(elsewhere.admin, 'test-items_get', { id: item.id })).value,
    ).toMatchObject({ status: 404 });
    expect(
      (await call(team.viewer, 'test-items_get', { id: 'not-an-id' })).isError,
    ).toBe(true);
  });

  it("lists with the list's filters, sorts and pages; only what the caller may read", async () => {
    const tag = randomUUID().slice(0, 8);
    await createTestItem(app, team.editor.headers, { title: `${tag} one` });
    await createTestItem(app, team.editor.headers, {
      title: `${tag} two`,
      status: 'done',
    });
    const first = await call(team.editor, 'test-items_list', {
      'title.contains': tag,
      sort: 'title',
      limit: 1,
    });
    expect(first.value.items.map((i: { title: string }) => i.title)).toEqual([
      `${tag} one`,
    ]);
    const next = await call(team.editor, 'test-items_list', {
      'title.contains': tag,
      sort: 'title',
      limit: 1,
      cursor: first.value.nextCursor,
    });
    expect(next.value.items.map((i: { title: string }) => i.title)).toEqual([
      `${tag} two`,
    ]);
    const done = await call(team.viewer, 'test-items_list', {
      filter: { field: 'status', op: 'eq', value: 'done' },
      'title.contains': tag,
    });
    expect(done.value.items).toHaveLength(1);
    expect(
      (await call(team.nobody, 'test-items_list', { 'title.contains': tag }))
        .value.items,
    ).toEqual([]);
    expect(
      (await call(team.editor, 'test-items_list', { sort: 'nope' })).value,
    ).toMatchObject({ status: 400, code: 'validation_failed' });
  });

  it('updates as PATCH does: the policy on the row, the audit of the change', async () => {
    const item = await createTestItem(app, team.editor.headers);
    const changed = await call(team.editor, 'test-items_update', {
      id: item.id,
      changes: { title: 'Changed by an agent' },
    });
    expect(changed.value.record).toMatchObject({
      title: 'Changed by an agent',
    });
    expect((await audited(item.id)).map((e) => e.action)).toEqual([
      'testItem.created',
      'testItem.updated',
    ]);
    expect(
      (
        await call(team.viewer, 'test-items_update', {
          id: item.id,
          changes: { title: 'Nope' },
        })
      ).value,
    ).toMatchObject({ status: 403 });
    expect(
      (
        await call(team.other, 'test-items_update', {
          id: item.id,
          changes: { title: 'Nope' },
        })
      ).value,
    ).toMatchObject({ status: 404 });
  });

  it('takes the etag as ifMatch, as PATCH and DELETE take If-Match: a stale one is a 412', async () => {
    const item = await createTestItem(app, team.editor.headers);
    const { etag } = (
      await call(team.editor, 'test-items_get', { id: item.id })
    ).value;
    const changed = await call(team.editor, 'test-items_update', {
      id: item.id,
      changes: { title: 'First change' },
      ifMatch: etag,
    });
    expect(changed.value.record.title).toBe('First change');
    expect(changed.value.etag).not.toBe(etag);
    expect(
      (
        await call(team.editor, 'test-items_update', {
          id: item.id,
          changes: { title: 'Lost update' },
          ifMatch: etag,
        })
      ).value,
    ).toMatchObject({ status: 412, code: 'precondition_failed' });
    expect(
      (
        await call(team.editor, 'test-items_delete', {
          id: item.id,
          ifMatch: etag,
        })
      ).value,
    ).toMatchObject({ status: 412, code: 'precondition_failed' });
    expect(
      (
        await call(team.editor, 'test-items_delete', {
          id: item.id,
          ifMatch: changed.value.etag,
        })
      ).value,
    ).toEqual({ id: item.id, deleted: true });
  });

  it('searches as GET /v1/search does: only what the caller may read', async () => {
    const word = `zq${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const item = await createTestItem(app, team.editor.headers, {
      title: `Find ${word}`,
    });
    const found = await call(team.viewer, 'search', { q: word });
    expect(found.value.items).toEqual([
      expect.objectContaining({ subject: 'TestItem', id: item.id }),
    ]);
    expect(
      (await call(team.nobody, 'search', { q: word })).value.items,
    ).toEqual([]);
  });

  it('deletes as DELETE does: refused without the permission, then gone', async () => {
    const item = await createTestItem(app, team.editor.headers);
    expect(
      (await call(team.viewer, 'test-items_delete', { id: item.id })).value,
    ).toMatchObject({ status: 403 });
    expect(
      (await call(team.editor, 'test-items_delete', { id: item.id })).value,
    ).toEqual({ id: item.id, deleted: true });
    expect(
      (await call(team.editor, 'test-items_get', { id: item.id })).value,
    ).toMatchObject({ status: 404 });
    expect((await audited(item.id)).map((e) => e.action)).toContain(
      'testItem.deleted',
    );
  });

  it('lets an API client act on its own records only', async () => {
    const client = await apiClient(app, team.tenantId);
    const created = await call(client, 'test-items_create', { title: 'Mine' });
    expect(created.value.record.ownerId).toBe(`client:${client.client.id}`);
    const someone = await createTestItem(app, team.editor.headers);
    expect(
      (await call(client, 'test-items_get', { id: someone.id })).value,
    ).toMatchObject({ status: 404 });
  });

  it('in read-only mode answers the tools that read and refuses those that write', async () => {
    const item = await createTestItem(app, team.editor.headers);
    const mode = vi
      .spyOn(app.get(ModeService), 'get')
      .mockResolvedValue('read-only');
    try {
      const list = await call(team.editor, 'test-items_list', {});
      expect(list.isError).toBe(false);
      const read = await call(team.editor, 'test-items_get', { id: item.id });
      expect(read.value.record.id).toBe(item.id);
      const title = `Refused ${randomUUID()}`;
      expect(
        (await call(team.editor, 'test-items_create', { title })).value,
      ).toMatchObject({ status: 503, code: 'read_only' });
      expect(
        (
          await call(team.editor, 'test-items_update', {
            id: item.id,
            changes: { title },
          })
        ).value,
      ).toMatchObject({ status: 503, code: 'read_only' });
      // Nothing written: no record by that title, only the item's creation audited.
      mode.mockRestore();
      expect(
        (
          await call(team.editor, 'test-items_list', {
            'title.contains': title,
          })
        ).value.items,
      ).toEqual([]);
      expect((await audited(item.id)).map((e) => e.action)).toEqual([
        'testItem.created',
      ]);
    } finally {
      mode.mockRestore();
    }
  });

  it('in maintenance refuses the endpoint itself', async () => {
    const mode = vi
      .spyOn(app.get(ModeService), 'get')
      .mockResolvedValue('maintenance');
    try {
      const { status, body } = await rpc(team.editor.headers, 'tools/list');
      expect(status).toBe(503);
      expect(body.code).toBe('maintenance');
    } finally {
      mode.mockRestore();
    }
  });
});
