import { AuthorizationService } from '@nestjs/authorization';
import {
  HttpException,
  HttpStatus,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { AfterCommit, ApprovalEngine } from './approval-engine.service.js';
import { ApprovalPoliciesService } from './approval-policies.service.js';
import { ApprovalsRegistry } from './approvals.registry.js';
import { ApprovalsRepository } from './approvals.repository.js';
import { ApprovalsService } from './approvals.service.js';
import type { ApprovalRequestRow } from './approvals.tables.js';

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
    link: '/invoices/i1',
    payload: {},
    policyVersion: 0,
    status: 'pending',
    round: 0,
    currentStage: 0,
    stageStartedAt: new Date(),
    stageOutcome: null,
    dueAt: null,
    comment: null,
    outcomeReason: null,
    endedAt: null,
    outcomeAppliedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    policy: { stages: [{ name: 'First', mode: { type: 'any' } }] },
    ...over,
  }) as unknown as ApprovalRequestRow;

const assignment = (approverId: string, status = 'pending') => ({
  id: `a-${approverId}`,
  requestId: 'r1',
  round: 0,
  stage: 0,
  approverId,
  status,
  decidedBy: status === 'pending' ? null : approverId,
});

/** ApprovalsService's rules on a stubbed repository and engine: no database. */
describe('ApprovalsService', () => {
  const repository = {
    lock: vi.fn(),
    findReadable: vi.fn(),
    stageAssignments: vi.fn(),
    assignmentsOf: vi.fn(),
    timelineOf: vi.fn(),
    decide: vi.fn(),
    blocking: vi.fn(),
    lockRecord: vi.fn(),
  };
  const engine = {
    run: (work: (after: AfterCommit) => Promise<unknown>) =>
      work(new AfterCommit()),
    problem: (
      status: HttpStatus,
      code: string,
      _key: string,
      extra: object = {},
    ) => new HttpException({ code, ...extra }, status),
    text: (key: string) => key,
    lock: vi.fn(),
    event: vi.fn(),
    record: vi.fn(),
    settleStage: vi.fn(),
    recordOf: vi.fn(),
    approvers: { delegators: vi.fn() },
  };
  const policies = { effective: vi.fn() };
  const registry = { action: vi.fn(), apply: vi.fn() };
  const access = { sqlFilter: vi.fn(), can: vi.fn() };
  const records = { of: vi.fn() };
  const authorization = { authorize: vi.fn() };
  const user = { kind: 'user', id: 'u1', name: 'Una' } as UserPrincipal;
  let service: ApprovalsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    engine.approvers.delegators.mockResolvedValue([]);
    repository.assignmentsOf.mockResolvedValue([]);
    repository.timelineOf.mockResolvedValue([]);
    access.can.mockResolvedValue(false);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ApprovalsService,
        { provide: ApprovalsRepository, useValue: repository },
        { provide: ApprovalEngine, useValue: engine },
        { provide: ApprovalPoliciesService, useValue: policies },
        { provide: ApprovalsRegistry, useValue: registry },
        { provide: AccessService, useValue: access },
        { provide: Records, useValue: records },
        { provide: AuthorizationService, useValue: authorization },
      ],
    })
      // The workflow client and the settings: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(ApprovalsService);
  });

  /** The request locked and readable by the caller. */
  const readable = (row: ApprovalRequestRow) => {
    engine.lock.mockResolvedValue(row);
    repository.findReadable.mockResolvedValue(row);
  };

  describe('decide', () => {
    it('refuses the requester: 403 approval_self_approval', async () => {
      readable(request({ requester: 'user:u1' }));
      await expect(
        service.decide(user, 'r1', 'approved', undefined),
      ).rejects.toMatchObject({
        status: 403,
        response: { code: 'approval_self_approval' },
      });
    });

    it('refuses an ended request: 409 approval_closed', async () => {
      readable(request({ status: 'rejected' }));
      await expect(
        service.decide(user, 'r1', 'approved', undefined),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'approval_closed' },
      });
    });

    it('refuses someone not assigned, nor standing in: 403 approval_not_assignee', async () => {
      readable(request());
      repository.stageAssignments.mockResolvedValue([assignment('u2')]);
      await expect(
        service.decide(user, 'r1', 'approved', undefined),
      ).rejects.toMatchObject({ response: { code: 'approval_not_assignee' } });
    });

    it('decides the assignments the user holds or stands in for, then settles the stage', async () => {
      const row = request();
      readable(row);
      repository.stageAssignments.mockResolvedValue([
        assignment('u1'),
        assignment('boss'),
        assignment('u3'),
      ]);
      engine.approvers.delegators.mockResolvedValue([
        { from: 'boss', subject: null },
      ]);
      repository.decide.mockResolvedValue([
        { onBehalfOf: null },
        { onBehalfOf: 'boss' },
      ]);
      engine.settleStage.mockResolvedValue(row);

      await service.decide(user, 'r1', 'approved', 'Fine');
      expect(repository.decide).toHaveBeenCalledWith(
        ['a-u1', 'a-boss'],
        'approved',
        'Fine',
        user,
      );
      expect(engine.event).toHaveBeenCalledWith(
        row,
        'decided',
        expect.anything(),
        { decision: 'approved', comment: 'Fine', onBehalfOf: ['boss'] },
        0,
      );
      expect(engine.settleStage).toHaveBeenCalledWith(
        expect.any(AfterCommit),
        row,
        user,
        expect.objectContaining({ decision: 'approved' }),
      );
    });

    it('compares If-Match under the lock: 412 when the request changed', async () => {
      readable(request());
      await expect(
        service.decide(user, 'r1', 'approved', undefined, undefined, '"stale"'),
      ).rejects.toBeInstanceOf(PreconditionFailedException);
      expect(repository.decide).not.toHaveBeenCalled();
    });
  });

  it('answers 404 for a request the principal may not read', async () => {
    repository.findReadable.mockResolvedValue(undefined);
    await expect(service.detail(user, 'r1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses a write to a record with an open request: 409 approval_pending', async () => {
    repository.blocking.mockResolvedValue({ id: 'r1' });
    await expect(
      service.assertNotPending('Invoice', 'i1'),
    ).rejects.toMatchObject({
      response: { code: 'approval_pending', approvalId: 'r1' },
    });
  });

  it('refuses a resubmission by anyone but the requester: 403', async () => {
    repository.findReadable.mockResolvedValue(
      request({ status: 'changes_requested' }),
    );
    await expect(service.resubmit(user, 'r1')).rejects.toMatchObject({
      status: 403,
    });
  });

  it('applies an action at once when its policy is off, once the user may update the record', async () => {
    const record = { id: 'i1', title: 'Invoice 1' };
    records.of.mockReturnValue({
      store: { findOne: vi.fn().mockResolvedValue(record) },
      feature: { policy: class {}, table: {} },
      declaration: { noun: 'invoice', path: 'invoices' },
    });
    registry.action.mockReturnValue({});
    policies.effective.mockResolvedValue({
      policy: { enabled: false, stages: [] },
      version: 0,
    });
    repository.lockRecord.mockResolvedValue({ id: 'i1' });
    engine.recordOf.mockResolvedValue(record);

    await expect(
      service.act(user, 'Invoice', 'i1', 'publish'),
    ).resolves.toEqual({ status: 'applied', approvalId: null });
    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.any(Function),
      'update',
      user,
      record,
    );
    expect(registry.apply).toHaveBeenCalledWith('Invoice.publish', {
      id: 'i1',
      actor: user,
    });
  });
});
