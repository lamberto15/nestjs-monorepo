import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Events } from '../../core/outbox/events.js';
import { tenancyConfig } from '../../core/tenancy/tenancy.config.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { authConfig } from '../auth/auth.config.js';
import type { UserPrincipal } from '../auth/principal.js';
import { tenantsConfig } from './tenants.config.js';
import { TenantsRepository } from './tenants.repository.js';
import { TenantsService } from './tenants.service.js';

/** TenantsService's rules on a stubbed repository: no database. */
describe('TenantsService', () => {
  const repository = {
    lock: vi.fn(),
    findView: vi.fn(),
    update: vi.fn(),
    scheduleDeletion: vi.fn(),
    lockForPurge: vi.fn(),
    delete: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const operator = { kind: 'user', id: 'op' } as UserPrincipal;
  const tenant = {
    id: 't1',
    slug: 'acme',
    name: 'Acme',
    active: true,
    operator: false,
    deletionScheduledFor: null,
    deletionStartedAt: null,
  };
  let service: TenantsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: TenantsRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: Events, useValue: { publish: vi.fn() } },
        {
          provide: Tenancy,
          useValue: {
            run: (_: unknown, work: () => unknown) => work(),
            current: () => ({ tenantId: 'ops' }),
          },
        },
        { provide: tenantsConfig.KEY, useValue: { deletionGraceDays: 30 } },
        { provide: authConfig.KEY, useValue: { operatorTenant: 'ops' } },
        { provide: tenancyConfig.KEY, useValue: { mode: 'multi' } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({ emitAsync: vi.fn() }))
      .compile();
    service = moduleRef.get(TenantsService);
    repository.lock.mockResolvedValue(true);
  });

  it('answers 404 for a tenant that is not there', async () => {
    repository.lock.mockResolvedValue(false);
    await expect(
      service.update(operator, 't9', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('checks If-Match under the lock, changing nothing on a stale one', async () => {
    repository.findView.mockResolvedValue(tenant);
    await expect(
      service.update(operator, 't1', { name: 'X' }, undefined, '"stale"'),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it("never deactivates the operators' tenant nor gives its slug away", async () => {
    repository.findView.mockResolvedValue({ ...tenant, operator: true });
    await expect(
      service.update(operator, 't1', { active: false }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'operator_tenant' }),
    });
    repository.findView.mockResolvedValue(tenant);
    await expect(
      service.update(operator, 't1', { slug: 'ops' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'tenant_slug_taken' }),
    });
  });

  it('wants the slug typed again to delete', async () => {
    repository.findView.mockResolvedValue(tenant);
    await expect(
      service.requestDeletion(operator, 't1', 'acne'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.scheduleDeletion).not.toHaveBeenCalled();
  });

  it('never reactivates a tenant whose deletion is pending', async () => {
    repository.findView.mockResolvedValue({
      ...tenant,
      active: false,
      deletionScheduledFor: new Date(),
    });
    await expect(
      service.update(operator, 't1', { active: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("purges nothing of the operators' tenant", async () => {
    repository.lockForPurge.mockResolvedValue({ id: 't1', operator: true });
    await expect(
      service.purge({ kind: 'system' } as never, 't1', 'deletion'),
    ).resolves.toBeUndefined();
    expect(repository.delete).not.toHaveBeenCalled();
  });
});
