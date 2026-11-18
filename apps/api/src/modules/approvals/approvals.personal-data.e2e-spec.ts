import { ApprovalEngine } from './approval-engine.service.js';
import { ApprovalsPersonalData } from './approvals.personal-data.js';
import {
  approvalAssignments,
  approvalDelegations,
  approvalEvents,
  approvalRequests,
} from './approvals.tables.js';
import { personalDataSection, uuid } from '../../../test/personal-data.js';

vi.hoisted(() => {
  Object.assign(process.env, {
    SCHEDULER: 'off',
    IDEMPOTENCY: 'optional',
    APP_ROLE: 'all',
    STORAGE_DRIVER: 'memory',
    DATA_ENCRYPTION_KEYS: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
    REDIS_PREFIX: `test-personal-approvals-${process.pid}-${Date.now()}`,
  });
});

/** The `approvals` section (approvals.personal-data.ts): what the person's export holds, and their deletion. */
personalDataSection(
  'approvals',
  [
    ApprovalsPersonalData,
    { provide: ApprovalEngine, useValue: { release: vi.fn() } },
  ],
  {
    seed: async (c) => {
      const request = (requester: string, name: string) => ({
        subject: 'TestItem',
        recordId: uuid(),
        action: 'publish',
        requester,
        requesterName: name,
        title: name,
        payload: {},
        policy: {} as never,
        policyVersion: 0,
      });
      const [mine, theirs] = await c.inTenant(() =>
        c.db
          .insert(approvalRequests)
          .values([request(c.a.key, 'Ada'), request(c.b.key, 'Bob')])
          .returning(),
      );
      await c.inTenant(async () => {
        await c.db.insert(approvalAssignments).values([
          {
            requestId: theirs!.id,
            round: 0,
            stage: 0,
            approverId: c.a.id,
            status: 'approved',
            decidedBy: c.a.id,
            decidedByName: 'Ada',
          },
          {
            requestId: mine!.id,
            round: 0,
            stage: 0,
            approverId: c.b.id,
            status: 'approved',
            decidedBy: c.b.id,
            decidedByName: 'Bob',
          },
        ]);
        await c.db.insert(approvalDelegations).values({
          fromUserId: c.a.id,
          toUserId: c.b.id,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + 1000),
        });
        await c.db.insert(approvalEvents).values([
          {
            requestId: mine!.id,
            type: 'requested',
            actor: c.a.key,
            actorName: 'Ada',
            round: 0,
          },
          {
            requestId: theirs!.id,
            type: 'requested',
            actor: c.b.key,
            actorName: 'Bob',
            round: 0,
          },
        ]);
      });
    },
    exported: async (c) => {
      const rows = await c.exported(c.a.id, 'approvals');
      expect(
        rows
          .map((r) => r.kind)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['decision', 'delegation', 'request']);
    },
    erased: async (c) => {
      // oxlint-disable-next-line typescript/unbound-method
      expect(vi.mocked(c.app.get(ApprovalEngine).release)).toHaveBeenCalledWith(
        c.a.id,
        expect.objectContaining({ kind: 'system' }),
      );
      const requests = await c.inTenant(() =>
        c.db.select().from(approvalRequests),
      );
      expect(
        requests
          .map((r) => r.requesterName)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['Bob', 'Deleted user']);
      const decisions = await c.inTenant(() =>
        c.db.select().from(approvalAssignments),
      );
      expect(
        decisions
          .map((r) => r.decidedByName)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(['Bob', 'Deleted user']);
      const events = await c.inTenant(() => c.db.select().from(approvalEvents));
      expect(
        events
          .map((r) => r.actorName)
          .sort((x, y) => String(x).localeCompare(String(y))),
      ).toEqual(
        ['Ada', 'Bob']
          .map((n) => (n === 'Ada' ? 'Deleted user' : n))
          .sort((x, y) => String(x).localeCompare(String(y))),
      );
    },
  },
);
