import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { QuotaRegistration, type StockQuota } from './quota.js';
import { QuotasRepository } from './quotas.repository.js';
import { DEFAULT_PLAN, QuotasService } from './quotas.service.js';

/** QuotasService's rules on a stubbed repository: no database. */
describe('QuotasService', () => {
  const repository = {
    tenantLimits: vi.fn(),
    lockTenantLimits: vi.fn(),
    saveTenantLimits: vi.fn(),
    deleteTenantLimits: vi.fn(),
    plansNamed: vi.fn(),
    planExists: vi.fn(),
    deletePlan: vi.fn(),
    lock: vi.fn(),
    count: vi.fn(),
  };
  const tenancy = {
    find: vi.fn(),
    current: vi.fn(),
    run: (_: string, work: () => unknown) => work(),
  };
  const audit = { record: vi.fn() };
  const notes: StockQuota = {
    key: 'notes',
    label: 'Notes',
    kind: 'stock',
    default: 10,
    count: vi.fn(),
  };
  const discovery = {
    getProviders: () => [{ instance: new QuotaRegistration([notes]) }],
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const tenantId = '0190f0a0-0000-7000-8000-000000000001';
  let service: QuotasService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        QuotasService,
        { provide: QuotasRepository, useValue: repository },
        { provide: Tenancy, useValue: tenancy },
        { provide: AuditService, useValue: audit },
        { provide: DiscoveryService, useValue: discovery },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Redis: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(QuotasService);
    service.onModuleInit();
  });

  it("takes the tenant's own limit, then its plan's, the default plan's, the quota's", async () => {
    repository.tenantLimits.mockResolvedValue({ plan: 'pro', limits: {} });
    repository.plansNamed.mockResolvedValue([
      { name: DEFAULT_PLAN, limits: { notes: 5 } },
    ]);
    await expect(service.limitOf(notes, tenantId)).resolves.toBe(5);
    expect(repository.plansNamed).toHaveBeenCalledWith(['pro', DEFAULT_PLAN]);

    repository.tenantLimits.mockResolvedValue({
      plan: null,
      limits: { notes: 2 },
    });
    await expect(service.limitOf(notes, tenantId)).resolves.toBe(2);

    repository.tenantLimits.mockResolvedValue(undefined);
    repository.plansNamed.mockResolvedValue([]);
    await expect(service.limitOf(notes, tenantId)).resolves.toBe(10);
  });

  it('refuses past the limit with 422 quota_exceeded, after taking the lock', async () => {
    repository.tenantLimits.mockResolvedValue({
      plan: null,
      limits: { notes: 3 },
    });
    repository.count.mockResolvedValue(3);
    const tenantScope = await import('../../core/tenancy/tenant-scope.js');
    vi.spyOn(tenantScope, 'requireTenantId').mockReturnValue(tenantId);
    await expect(service.assertRoom(notes)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(repository.lock).toHaveBeenCalledWith('notes');
  });

  it('refuses an unknown quota key or plan: 400', async () => {
    tenancy.find.mockResolvedValue({ id: tenantId, slug: 'acme' });
    await expect(
      service.setTenantLimits(user, tenantId, { limits: { nope: 1 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    repository.planExists.mockResolvedValue(false);
    await expect(
      service.setTenantLimits(user, tenantId, { plan: 'gold' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.saveTenantLimits).not.toHaveBeenCalled();
  });

  it('answers 404 for a plan that is not there', async () => {
    repository.deletePlan.mockResolvedValue(false);
    await expect(service.deletePlan(user, 'gold')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });
});
