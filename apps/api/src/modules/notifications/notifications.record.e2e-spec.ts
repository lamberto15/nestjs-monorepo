import { randomUUID } from 'node:crypto';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { bootModules } from '../../../test/boot.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { inAuditRun } from '../../iam/audit/audit-run.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { NotificationsModule } from './notifications.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-record-watch-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

describe('watching a record (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      NotificationsModule,
      testItemsModule({ imports: [NotificationsModule.forRecord(TEST_ITEM)] }),
    );
    team = await recordsTenant(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const watching = async (id: string, headers: Record<string, string>) =>
    (await call('GET', `/v1/test-items/${id}?include=watching`, headers)).json()
      .watching;
  const inbox = async (headers: Record<string, string>) =>
    (await call('GET', '/v1/notifications', headers)).json().items as {
      type: string;
      title: string;
      body: string;
      count: number;
      link: string;
    }[];

  it('watches and stops, for whoever may read it; the creator watches from the start', async () => {
    const item = await createTestItem(app, team.editor.headers);
    expect(await watching(item.id, team.editor.headers)).toBe(true);
    expect(await watching(item.id, team.viewer.headers)).toBe(false);

    const watch = await call(
      'POST',
      `/v1/test-items/${item.id}/watch`,
      team.viewer.headers,
    );
    expect(watch.statusCode).toBe(200);
    expect(watch.json()).toEqual({ watching: true });
    expect(await watching(item.id, team.viewer.headers)).toBe(true);
    // The list says it too, one query for the page.
    const list = await call(
      'GET',
      '/v1/test-items?include=watching',
      team.viewer.headers,
    );
    expect(
      list.json().items.find((each: { id: string }) => each.id === item.id)
        .watching,
    ).toBe(true);

    // Someone who may not read it gets the 404 of a missing one.
    expect(
      (
        await call(
          'POST',
          `/v1/test-items/${item.id}/watch`,
          team.nobody.headers,
        )
      ).statusCode,
    ).toBe(404);

    expect(
      (
        await call(
          'DELETE',
          `/v1/test-items/${item.id}/watch`,
          team.viewer.headers,
        )
      ).statusCode,
    ).toBe(204);
    expect(await watching(item.id, team.viewer.headers)).toBe(false);
    expect(
      (
        await call(
          'DELETE',
          `/v1/test-items/${item.id}/watch`,
          team.viewer.headers,
        )
      ).statusCode,
    ).toBe(404);
  });

  it('tells the watchers of a change, but not the one who made it, one notification per record', async () => {
    const item = await createTestItem(app, team.editor.headers, {
      title: 'Roadmap',
    });
    await call('POST', `/v1/test-items/${item.id}/watch`, team.viewer.headers);
    for (const title of ['Roadmap v2', 'Roadmap v3']) {
      const changed = await call(
        'PATCH',
        `/v1/test-items/${item.id}`,
        team.admin.headers,
        { title },
      );
      expect(changed.statusCode).toBe(200);
    }
    for (const who of [team.editor, team.viewer]) {
      const [note] = await inbox(who.headers);
      expect(note).toMatchObject({
        type: 'record.changed',
        count: 2,
        link: `/test-items/${item.id}`,
      });
      expect(note!.body).toContain('Roadmap v3');
    }
    // The one who changed it knows: the creator's own edit tells nobody else watching nothing.
    expect(await inbox(team.admin.headers)).toEqual([]);
  });

  it('tells a watcher of a bulk run once, opening the list of what it changed', async () => {
    const { editor, admin, tenantId } = await recordsTenant(app);
    const total = 4;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      ids.push((await createTestItem(app, editor.headers)).id);
    }
    const { store } = app.get(Records).of('TestItem');
    const by = {
      kind: 'user',
      id: admin.id,
      name: 'Admin',
      email: 'admin@example.com',
      emailVerified: true,
      locale: null,
      timezone: null,
      tenantId,
    } satisfies UserPrincipal;
    const runId = randomUUID();
    await app.get(Tenancy).run(tenantId, () =>
      inAuditRun(runId, async () => {
        for (const id of ids) await store.update(by, id, { status: 'done' });
      }),
    );
    const notes = await inbox(editor.headers);
    expect(notes.filter((each) => each.type === 'record.changed')).toEqual([]);
    const summary = notes.filter((each) => each.type === 'record.bulk-changed');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      count: total,
      link: `/test-items?bulkRun=${runId}`,
    });
  });
});
