import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { WorkflowClient } from '@nestjs/workflows';
import { Events } from '../../core/outbox/events.js';
import { SystemContext } from '../../iam/access/system-context.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Realtime } from '../realtime/realtime.service.js';
import { ApprovalDelegationsRepository } from './approval-delegations.repository.js';
import { AfterCommit, ApprovalEngine } from './approval-engine.service.js';
import type { ApprovalPolicy } from './approval-policy.js';
import { ApprovalsRepository } from './approvals.repository.js';
import type { ApprovalRequestRow } from './approvals.tables.js';
import { Approvers } from './approvers.js';

const stage = (name: string) =>
  ({
    name,
    approvers: [{ type: 'users', userIds: ['u1'] }],
    mode: { type: 'any' },
    onOverdue: 'expire',
  }) as unknown as ApprovalPolicy['stages'][number];

const request = (over: Partial<ApprovalRequestRow> = {}) =>
  ({
    id: 'r1',
    tenantId: 't1',
    subject: 'Invoice',
    recordId: 'i1',
    action: 'publish',
    requester: 'user:req',
    requesterName: 'Requester',
    title: 'Invoice 1',
    status: 'pending',
    round: 0,
    currentStage: 0,
    stageStartedAt: null,
    stageOutcome: null,
    outcomeAppliedAt: null,
    policy: { stages: [stage('First'), stage('Second')] },
    ...over,
  }) as ApprovalRequestRow;

const vote = (approverId: string, status: string, decidedBy?: string) => ({
  approverId,
  status,
  decidedAt: status === 'pending' ? null : new Date(),
  decidedBy: decidedBy ?? (status === 'pending' ? null : approverId),
});

/** The engine's transitions on stubbed repositories: no database. */
describe('ApprovalEngine', () => {
  const repository = {
    lock: vi.fn(),
    update: vi.fn(),
    assign: vi.fn(),
    insertEvent: vi.fn(),
    stageAssignments: vi.fn(),
    closePending: vi.fn(),
    hasEvent: vi.fn(),
  };
  const approvers = { resolve: vi.fn(), delegatesOf: vi.fn() };
  const notifications = { notify: vi.fn() };
  const realtime = { toPrincipals: vi.fn() };
  const audit = { record: vi.fn() };
  const events = { publish: vi.fn() };
  const workflows = { signal: vi.fn() };
  const system = { current: vi.fn() };
  const txHost = {
    tx: {},
    withTransaction: (...args: unknown[]) =>
      (args.at(-1) as () => Promise<unknown>)(),
  };
  let engine: ApprovalEngine;

  beforeEach(async () => {
    vi.resetAllMocks();
    system.current.mockReturnValue({ kind: 'system', key: 'approvals' });
    approvers.delegatesOf.mockResolvedValue(new Map());
    repository.closePending.mockResolvedValue([]);
    repository.update.mockImplementation((_id, values) =>
      Promise.resolve(request(values)),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApprovalEngine,
        { provide: ApprovalsRepository, useValue: repository },
        { provide: ApprovalDelegationsRepository, useValue: {} },
        { provide: Approvers, useValue: approvers },
        { provide: NotificationsService, useValue: notifications },
        { provide: Realtime, useValue: realtime },
        { provide: AuditService, useValue: audit },
        { provide: Events, useValue: events },
        { provide: WorkflowClient, useValue: workflows },
        { provide: SystemContext, useValue: system },
        { provide: TransactionHost, useValue: txHost },
      ],
    })
      // The registry, the records and i18n: unused by these transitions.
      .useMocker(() => ({}))
      .compile();
    engine = moduleRef.get(ApprovalEngine);
  });

  describe('startStage', () => {
    it('answers `gone` for a purged request and `raced` for another round', async () => {
      repository.lock.mockResolvedValueOnce(undefined);
      await expect(engine.startStage('r1', 0, 0)).resolves.toBe('gone');
      repository.lock.mockResolvedValueOnce(request({ round: 1 }));
      await expect(engine.startStage('r1', 0, 0)).resolves.toBe('raced');
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('assigns the approvers it resolves, and tells them', async () => {
      repository.lock.mockResolvedValue(request());
      approvers.resolve.mockResolvedValue(['u1']);
      repository.assign.mockResolvedValue([{ approverId: 'u1' }]);
      repository.stageAssignments.mockResolvedValue([vote('u1', 'pending')]);

      await expect(engine.startStage('r1', 0, 0)).resolves.toBe('started');
      expect(repository.update).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({ currentStage: 0, stageOutcome: null }),
      );
      expect(repository.assign).toHaveBeenCalledWith([
        expect.objectContaining({ requestId: 'r1', approverId: 'u1' }),
      ]);
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'approval.requested',
          to: ['user:u1'],
        }),
      );
      expect(repository.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stage_started', stage: 0 }),
      );
    });

    it('fails the request when nobody may decide the stage (no_approvers)', async () => {
      repository.lock.mockResolvedValue(request());
      approvers.resolve.mockResolvedValue([]);

      await expect(engine.startStage('r1', 0, 0)).resolves.toBe('failed');
      expect(repository.update).toHaveBeenCalledWith(
        'r1',
        expect.objectContaining({
          status: 'failed',
          outcomeReason: 'no_approvers',
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'approval.failed' }),
      );
      expect(events.publish).toHaveBeenCalled();
    });
  });

  describe('settleStage', () => {
    it('leaves an undecided stage as it is', async () => {
      repository.stageAssignments.mockResolvedValue([vote('u1', 'pending')]);
      const row = request();
      await expect(
        engine.settleStage(new AfterCommit(), row, null),
      ).resolves.toBe(row);
      expect(repository.update).not.toHaveBeenCalled();
      expect(workflows.signal).not.toHaveBeenCalled();
    });

    it('approves a stage with stages left: its other approvers closed, the workflow signalled', async () => {
      repository.stageAssignments.mockResolvedValue([
        vote('u1', 'approved'),
        vote('u2', 'pending'),
      ]);
      const settled = await engine.settleStage(
        new AfterCommit(),
        request(),
        null,
      );
      expect(settled.status).toBe('pending');
      expect(repository.update).toHaveBeenCalledWith('r1', {
        stageOutcome: 'approved',
      });
      expect(workflows.signal).toHaveBeenCalledWith(
        expect.anything(),
        { outcome: 'approved', tenantId: 't1' },
        expect.objectContaining({ key: 'r1:0:0' }),
      );
      expect(repository.closePending).toHaveBeenCalledWith('r1');
      expect(repository.insertEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'stage_approved' }),
      );
    });

    it('ends the request when its last stage is rejected, and tells the requester', async () => {
      repository.stageAssignments.mockResolvedValue([vote('u1', 'rejected')]);
      const settled = await engine.settleStage(
        new AfterCommit(),
        request({ currentStage: 1 }),
        null,
        { decision: 'rejected', comment: 'No' },
      );
      expect(settled.status).toBe('rejected');
      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'approval.rejected',
          to: 'user:req',
        }),
      );
      expect(events.publish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requestId: 'r1', status: 'rejected' }),
        { key: 'r1' },
      );
    });
  });

  it('reminds once: a retry finds the reminder sent', async () => {
    repository.lock.mockResolvedValue(request({ stageStartedAt: new Date() }));
    repository.hasEvent.mockResolvedValue(true);
    await expect(engine.remind('r1', 0, 0)).resolves.toBe('reminded');
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(repository.insertEvent).not.toHaveBeenCalled();
  });

  it('expires an overdue stage that does not escalate', async () => {
    repository.lock.mockResolvedValue(request());
    await expect(engine.overdue('r1', 0, 0)).resolves.toBe('expired');
    expect(repository.update).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ status: 'expired', outcomeReason: 'overdue' }),
    );
  });
});
