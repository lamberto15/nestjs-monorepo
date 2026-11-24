import { getDrizzleToken } from '@nestjs/drizzle';
import type { NestNodeApplication } from '@nestjs/platform-node';
import { and, eq } from 'drizzle-orm';
import { bootModules } from '../../../test/boot.js';
import { recordMetrics } from '../../../test/metrics.js';
import {
  ArchiveTestItem,
  PublishTestItem,
  TestItemApprovalEffects,
} from '../../../test/fixtures/approvals/test-item-approvals.js';
import { TEST_ITEM } from '../../../test/fixtures/test-items/test-item.record.js';
import { testItemsModule } from '../../../test/fixtures/test-items/test-items.module.js';
import {
  createTestItem,
  type Headers,
  recordsTenant,
  testItemModules,
} from '../../../test/records.js';
import type { Database } from '../../core/database/database.js';
import { MetricsModule } from '../../core/metrics/metrics.module.js';
import { QueuesModule } from '../../core/queues/queues.module.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { SharedWorkflowsModule } from '../../core/workflows/workflows.module.js';
import { auditLog } from '../../iam/audit/audit.tables.js';
import { ApprovalMetrics } from './approvals.metrics.js';
import { ApprovalsModule } from './approvals.module.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    MAIL_TRANSPORT: 'memory',
    APP_ROLE: 'all',
    REDIS_PREFIX: `test-approvals-${process.pid}-${Date.now()}`,
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
  });
});

interface Detail {
  id: string;
  status: string;
  round: number;
  outcomeReason: string | null;
  outcomeAppliedAt: string | null;
  assignments: {
    approverId: string;
    status: string;
    onBehalfOf: string | null;
  }[];
  timeline: { type: string }[];
  can: {
    decide: boolean;
    cancel: boolean;
    resubmit: boolean;
    abandon: boolean;
  };
}

describe('approvals on test items (e2e)', () => {
  let app: NestNodeApplication;
  let team: Awaited<ReturnType<typeof recordsTenant>>;
  // Registered before the app boots, so its gauges are made on it.
  const recorded = recordMetrics();
  afterAll(() => recorded.stop());

  beforeAll(async () => {
    app = await bootModules(
      ...testItemModules(),
      QueuesModule,
      MetricsModule,
      SharedWorkflowsModule,
      testItemsModule({
        imports: [
          ApprovalsModule.forRecord(TEST_ITEM, {
            publish: { label: 'Publish a test item', flag: false },
            archive: { label: 'Archive a test item' },
          }),
          TestItemApprovalEffects,
        ],
      }),
    );
  });
  afterAll(() => app?.close());
  // A tenant of its own per test: policies and flags are the tenant's.
  beforeEach(async () => {
    team = await recordsTenant(app);
  });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    headers: Headers,
    payload?: object,
  ) => app.inject({ method, url, headers, ...(payload && { payload }) });
  const db = () => app.get<Database>(getDrizzleToken());
  const inTenant = <T>(work: () => Promise<T>) =>
    app.get(Tenancy).run(team.tenantId, work);
  const detail = async (id: string, headers = team.admin.headers) => {
    const res = await call('GET', `/v1/approvals/${id}`, headers);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Detail>();
  };
  /** The request once `ready` holds: the workflow runs beside the test. */
  async function until(id: string, ready: (d: Detail) => boolean) {
    for (let i = 0; i < 150; i++) {
      const shown = await detail(id);
      if (ready(shown)) return shown;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Approval ${id} never got there: ${JSON.stringify(await detail(id))}`,
    );
  }
  const assigned = (id: string) =>
    until(id, (d) => d.assignments.some((a) => a.status === 'pending'));
  /** An item of the editor's, its publication asked for: 202 and the request's id. */
  async function requested(comment?: string) {
    const item = await createTestItem(app, team.editor.headers);
    const res = await call(
      'POST',
      `/v1/test-items/${item.id}/publish`,
      team.editor.headers,
      comment ? { comment } : undefined,
    );
    expect(res.statusCode, res.body).toBe(202);
    const { approvalId } = res.json<{ status: string; approvalId: string }>();
    return { item, approvalId };
  }
  const item = async (id: string) =>
    (await call('GET', `/v1/test-items/${id}`, team.admin.headers)).json<{
      status: string;
    }>();
  const policy = (stage: object = {}) => ({
    stages: [
      {
        name: 'Review',
        approvers: [{ type: 'permission', action: 'update' }],
        ...stage,
      },
    ],
  });

  it('offers the requests of an API client as webhook event types', async () => {
    const res = await call(
      'GET',
      '/v1/webhook-event-types',
      team.admin.headers,
    );
    const types = res
      .json<{ items: { group: string; types: { type: string }[] }[] }>()
      .items.filter((group) => group.group === 'approval')
      .flatMap((group) => group.types.map((t) => t.type));
    expect(types.sort()).toEqual(
      [
        'approval.requested',
        'approval.approved',
        'approval.rejected',
        'approval.changes-requested',
        'approval.cancelled',
        'approval.expired',
        'approval.failed',
      ].sort(),
    );
  });

  it('locks the record while pending, and applies the action once approved', async () => {
    const { item: record, approvalId } = await requested('Please');
    const url = `/v1/test-items/${record.id}`;

    // Pending: the record can't change, nor be asked for again.
    const edit = await call('PATCH', url, team.editor.headers, { title: 'x' });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ code: 'approval_pending', approvalId });
    expect((await call('DELETE', url, team.editor.headers)).statusCode).toBe(
      409,
    );
    const again = await call('POST', `${url}/publish`, team.editor.headers);
    expect(again.statusCode).toBe(409);

    const started = await assigned(approvalId);
    // The default policy: whoever may update the item, never the requester.
    expect(started.assignments.map((a) => a.approverId)).toEqual([
      team.admin.id,
    ]);
    expect(started.can.decide).toBe(true);

    // Neither the requester, nor someone else, nor an outsider decides.
    const self = await call(
      'POST',
      `/v1/approvals/${approvalId}/approve`,
      team.editor.headers,
    );
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('approval_self_approval');
    const other = await call(
      'POST',
      `/v1/approvals/${approvalId}/approve`,
      team.other.headers,
    );
    expect(other.statusCode).toBe(404);
    expect(
      (await call('GET', `/v1/approvals/${approvalId}`, team.viewer.headers))
        .statusCode,
    ).toBe(404);

    // The inbox: waiting on the admin, asked for by the editor.
    const mine = await call(
      'GET',
      '/v1/approvals?assignedToMe=true',
      team.admin.headers,
    );
    expect(
      mine.json<{ items: { id: string }[] }>().items.map((i) => i.id),
    ).toEqual([approvalId]);
    const asked = await call(
      'GET',
      '/v1/approvals?requestedByMe=true',
      team.editor.headers,
    );
    expect(
      asked.json<{ items: { id: string }[] }>().items.map((i) => i.id),
    ).toEqual([approvalId]);

    const stale = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${approvalId}/approve`,
      headers: { ...team.admin.headers, 'if-match': '"stale"' },
    });
    expect(stale.statusCode).toBe(412);
    const approved = await call(
      'POST',
      `/v1/approvals/${approvalId}/approve`,
      team.admin.headers,
      {
        comment: 'Fine',
      },
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json().status).toBe('approved');

    const applied = await until(approvalId, (d) => !!d.outcomeAppliedAt);
    expect(applied.timeline.map((e) => e.type)).toEqual([
      'requested',
      'stage_started',
      'decided',
      'approved',
    ]);
    expect((await item(record.id)).status).toBe('done');
    const last = PublishTestItem.applied.at(-1)!;
    expect(last).toMatchObject({ id: record.id, actor: { kind: 'system' } });
    const audited = await inTenant(() =>
      db()
        .select({ action: auditLog.action })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.targetType, 'approval'),
            eq(auditLog.targetId, approvalId),
          ),
        ),
    );
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'approval.requested',
        'approval.decided',
        'approval.approved',
      ]),
    );
    // Applied: the record is free again.
    expect(
      (await call('PATCH', url, team.editor.headers, { title: 'y' }))
        .statusCode,
    ).toBe(200);
  });

  it('rejects, sends back for changes, takes a resubmission and a withdrawal', async () => {
    const first = await requested();
    await assigned(first.approvalId);
    const bare = await call(
      'POST',
      `/v1/approvals/${first.approvalId}/reject`,
      team.admin.headers,
      {},
    );
    expect(bare.statusCode).toBe(400);
    const rejected = await call(
      'POST',
      `/v1/approvals/${first.approvalId}/reject`,
      team.admin.headers,
      {
        comment: 'No',
      },
    );
    expect(rejected.json().status).toBe('rejected');
    await until(first.approvalId, (d) => !!d.outcomeAppliedAt);
    expect((await item(first.item.id)).status).toBe('draft');
    expect(
      (
        await call(
          'PATCH',
          `/v1/test-items/${first.item.id}`,
          team.editor.headers,
          { title: 'z' },
        )
      ).statusCode,
    ).toBe(200);

    const second = await requested();
    await assigned(second.approvalId);
    const back = await call(
      'POST',
      `/v1/approvals/${second.approvalId}/request-changes`,
      team.admin.headers,
      { comment: 'A better title' },
    );
    expect(back.json().status).toBe('changes_requested');
    // Sent back: the record may change, and only the requester resubmits.
    expect(
      (
        await call(
          'PATCH',
          `/v1/test-items/${second.item.id}`,
          team.editor.headers,
          { title: 'Better' },
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await call(
          'POST',
          `/v1/approvals/${second.approvalId}/resubmit`,
          team.admin.headers,
        )
      ).statusCode,
    ).toBe(403);
    const resubmitted = await call(
      'POST',
      `/v1/approvals/${second.approvalId}/resubmit`,
      team.editor.headers,
    );
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(resubmitted.json()).toMatchObject({
      status: 'pending',
      round: 1,
      title: 'Better',
    });
    await until(
      second.approvalId,
      (d) => d.timeline.filter((e) => e.type === 'stage_started').length === 2,
    );

    const cancelled = await call(
      'POST',
      `/v1/approvals/${second.approvalId}/cancel`,
      team.editor.headers,
    );
    expect(cancelled.json().status).toBe('cancelled');
    const ended = await call(
      'POST',
      `/v1/approvals/${second.approvalId}/cancel`,
      team.editor.headers,
    );
    expect(ended.statusCode).toBe(409);
    expect(ended.json().code).toBe('approval_closed');
  });

  it('withdraws the requests of a deleted record', async () => {
    const { item: record, approvalId } = await requested();
    await assigned(approvalId);
    await call(
      'POST',
      `/v1/approvals/${approvalId}/request-changes`,
      team.admin.headers,
      {
        comment: 'Change it',
      },
    );
    const deleted = await call(
      'DELETE',
      `/v1/test-items/${record.id}`,
      team.editor.headers,
    );
    expect(deleted.statusCode, deleted.body).toBe(204);
    const shown = await detail(approvalId);
    expect(shown).toMatchObject({
      status: 'cancelled',
      outcomeReason: 'record_deleted',
    });
  });

  it('runs an action at once while its flag is off', async () => {
    const record = await createTestItem(app, team.editor.headers);
    const url = `/v1/test-items/${record.id}/archive`;
    const at = ArchiveTestItem.applied.length;
    const now = await call('POST', url, team.editor.headers);
    expect(now.statusCode, now.body).toBe(200);
    expect(now.json()).toEqual({ status: 'applied', approvalId: null });
    expect(ArchiveTestItem.applied[at]).toMatchObject({
      id: record.id,
      actor: { id: team.editor.id },
    });

    const on = await call(
      'PUT',
      '/v1/settings/testItems.archiveApproval',
      team.admin.headers,
      {
        value: true,
      },
    );
    expect(on.statusCode, on.body).toBe(200);
    const later = await call('POST', url, team.editor.headers);
    expect(later.statusCode, later.body).toBe(202);
    // Only those who may update the item ask.
    expect((await call('POST', url, team.viewer.headers)).statusCode).toBe(403);
  });

  it('lets administrators change a policy, and refuses a wrong one by its path', async () => {
    expect(
      (await call('GET', '/v1/approvals/policies', team.editor.headers))
        .statusCode,
    ).toBe(403);
    const list = await call(
      'GET',
      '/v1/approvals/policies',
      team.admin.headers,
    );
    expect(
      list.json<{ items: { key: string; version: number; source: string }[] }>()
        .items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'TestItem.publish',
          version: 0,
          source: 'code',
        }),
      ]),
    );
    expect(
      (await call('GET', '/v1/approvals/policy-types', team.admin.headers))
        .statusCode,
    ).toBe(200);

    const wrong = await call(
      'PUT',
      '/v1/approvals/policies/TestItem.publish',
      team.admin.headers,
      {
        stages: [{ name: 'Review', approvers: [{ type: 'role' }] }],
      },
    );
    expect(wrong.statusCode).toBe(400);
    expect(
      wrong.json<{ errors: { path: string }[] }>().errors.map((e) => e.path),
    ).toContain('stages.0.approvers.0.role');
    const off = await call(
      'PUT',
      '/v1/approvals/policies/TestItem.publish',
      team.admin.headers,
      {
        ...policy(),
        enabled: false,
      },
    );
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json()).toMatchObject({ version: 1, source: 'override' });

    // Off: the action runs at once.
    const record = await createTestItem(app, team.editor.headers);
    const now = await call(
      'POST',
      `/v1/test-items/${record.id}/publish`,
      team.editor.headers,
    );
    expect(now.statusCode).toBe(200);
    expect((await item(record.id)).status).toBe('done');

    const reset = await call(
      'DELETE',
      '/v1/approvals/policies/TestItem.publish',
      team.admin.headers,
    );
    expect(reset.json()).toMatchObject({ version: 2, source: 'code' });
  });

  it('lets a delegate decide for the approver, recorded on their behalf', async () => {
    const day = 86_400_000;
    const delegate = (payload: object) =>
      call('POST', '/v1/approvals/delegations', team.admin.headers, payload);
    const tooLong = await delegate({
      toUserId: team.viewer.id,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 200 * day).toISOString(),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().errors[0].path).toBe('endsAt');
    const self = await delegate({
      toUserId: team.admin.id,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + day).toISOString(),
    });
    expect(self.json().errors[0].path).toBe('toUserId');
    const given = await delegate({
      toUserId: team.viewer.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + day).toISOString(),
    });
    expect(given.statusCode, given.body).toBe(201);

    const { approvalId } = await requested();
    await assigned(approvalId);
    const approved = await call(
      'POST',
      `/v1/approvals/${approvalId}/approve`,
      team.viewer.headers,
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<Detail>().assignments[0]).toMatchObject({
      approverId: team.admin.id,
      status: 'approved',
      onBehalfOf: team.admin.id,
    });
    const held = await call(
      'GET',
      '/v1/approvals/delegations',
      team.viewer.headers,
    );
    expect(held.json<{ items: { active: boolean }[] }>().items).toMatchObject([
      { active: true },
    ]);
  });

  it('reports the overdue and unapplied gauges, across tenants', async () => {
    await requested();
    // Read by the one-instance job (SCHEDULER is off here), across every tenant (the maintenance role).
    await app.get(ApprovalMetrics).refresh();
    const [overdue] = await recorded.read('approvals_overdue_seconds');
    expect(overdue!.value).toBeGreaterThanOrEqual(0);
    const [unapplied] = await recorded.read('approvals_unapplied_seconds');
    expect(unapplied!.value).toBeGreaterThanOrEqual(0);
  });

  it('expires a stage nobody decided in time', async () => {
    const short = await call(
      'PUT',
      '/v1/approvals/policies/TestItem.publish',
      team.admin.headers,
      policy({
        dueAfter: '2s',
      }),
    );
    expect(short.statusCode, short.body).toBe(200);
    const { item: record, approvalId } = await requested();
    const expired = await until(approvalId, (d) => d.status === 'expired');
    expect(expired.outcomeReason).toBe('overdue');
    // Ended: the record is free.
    expect(
      (
        await call(
          'PATCH',
          `/v1/test-items/${record.id}`,
          team.editor.headers,
          { title: 'w' },
        )
      ).statusCode,
    ).toBe(200);
  });
});
