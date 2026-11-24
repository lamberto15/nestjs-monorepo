import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { ClsServiceManager } from 'nestjs-cls';
import { TENANT_SCOPE, tenantScope } from '../../core/tenancy/tenant-scope.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type {
  RequestPrincipal,
  UserPrincipal,
} from '../../iam/auth/principal.js';
import { UsageCounters } from './usage.counters.js';
import { UsageRepository } from './usage.repository.js';
import { UsageService } from './usage.service.js';

/** UsageService's rules on a stubbed repository: no database. */
describe('UsageService', () => {
  const repository = {
    quotaOf: vi.fn(),
    saveQuota: vi.fn(),
    deleteQuota: vi.fn(),
    clientExists: vi.fn(),
    rows: vi.fn(),
  };
  const counters = { live: vi.fn() };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: UsageService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsageService,
        { provide: UsageRepository, useValue: repository },
        { provide: UsageCounters, useValue: counters },
        { provide: AuditService, useValue: audit },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(UsageService);
  });

  it('answers 404 for a client the tenant does not have', async () => {
    repository.clientExists.mockResolvedValue(false);
    await expect(service.setQuota(user, 'c9', 10)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.saveQuota).not.toHaveBeenCalled();
  });

  it('removes the quota for null, audited with what it was', async () => {
    repository.clientExists.mockResolvedValue(true);
    repository.quotaOf.mockResolvedValue(100);
    await service.setQuota(user, 'c1', null);
    expect(repository.deleteQuota).toHaveBeenCalledWith('c1');
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        action: 'client.quota-changed',
        details: { dailyQuota: { from: 100, to: null } },
      }),
    );
  });

  it('gives a user no usage of their own: 403', async () => {
    await expect(
      service.ownUsage(user as RequestPrincipal, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('keeps the larger of a row and its live counter, and leaves out the total', async () => {
    repository.rows.mockResolvedValue([
      { day: '2026-11-24', route: 'GET /x', count: 3 },
    ]);
    counters.live.mockResolvedValue(
      new Map([['2026-11-24', { 'GET /x': '5', _total: '5' }]]),
    );
    const report = await ClsServiceManager.getClsService().run(async () => {
      ClsServiceManager.getClsService().set(
        TENANT_SCOPE,
        tenantScope('0190f0a0-0000-7000-8000-000000000001'),
      );
      return service.report(
        'c1',
        { from: '2026-11-24', to: '2026-11-24' },
        new Date('2026-11-24T12:00:00Z'),
      );
    });
    expect(report.days).toEqual([
      { day: '2026-11-24', total: 5, routes: { 'GET /x': 5 } },
    ]);
  });
});
