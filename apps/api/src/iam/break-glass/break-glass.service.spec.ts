import { TransactionHost } from '@nestjs-cls/transactional';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Events } from '../../core/outbox/events.js';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../access/access.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthPolicy } from '../auth/auth-policy.js';
import { OperatorGuard } from '../auth/operator-only.js';
import type { UserPrincipal } from '../auth/principal.js';
import { BreakGlassRepository } from './break-glass.repository.js';
import { BreakGlassService } from './break-glass.service.js';

/** BreakGlassService's rules on a stubbed repository: no database. */
describe('BreakGlassService', () => {
  const repository = {
    hasRunningGrant: vi.fn(),
    findOf: vi.fn(),
    insert: vi.fn(),
  };
  const tenancy = { find: vi.fn(), run: vi.fn() };
  const authPolicy = { allowsBreakGlass: vi.fn() };
  const operators = { actsAsOperator: vi.fn() };
  const access = { can: vi.fn() };
  const audit = { record: vi.fn() };
  const operator = {
    kind: 'user',
    id: 'op',
    tenantId: 'ops',
  } as UserPrincipal;
  const grantId = '0195b4a0-0000-7000-8000-000000000001';
  let service: BreakGlassService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        BreakGlassService,
        { provide: BreakGlassRepository, useValue: repository },
        { provide: Tenancy, useValue: tenancy },
        { provide: AuthPolicy, useValue: authPolicy },
        { provide: OperatorGuard, useValue: operators },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        { provide: Events, useValue: { publish: vi.fn() } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(BreakGlassService);
    tenancy.find.mockResolvedValue({ id: 't1', slug: 'acme', active: true });
    authPolicy.allowsBreakGlass.mockResolvedValue(true);
  });

  it('opens no second grant while one runs', async () => {
    repository.hasRunningGrant.mockResolvedValue(true);
    await expect(
      service.start(operator, 't1', { reason: 'outage' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.insert).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("never opens the operator's own tenant", async () => {
    tenancy.find.mockResolvedValue({ id: 'ops', active: true });
    await expect(
      service.start(operator, 'ops', { reason: 'x' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'break_glass_own_tenant' }),
    });
  });

  it('lets a request through a grant read only', async () => {
    operators.actsAsOperator.mockResolvedValue(true);
    access.can.mockResolvedValue(true);
    repository.findOf.mockResolvedValue({
      id: grantId,
      targetTenantId: 't1',
      endedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.open(operator, grantId, { method: 'POST', path: '/x', ip: '' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'break_glass_read_only' }),
    });
  });

  it('refuses an expired grant', async () => {
    operators.actsAsOperator.mockResolvedValue(true);
    access.can.mockResolvedValue(true);
    repository.findOf.mockResolvedValue({
      id: grantId,
      targetTenantId: 't1',
      endedAt: null,
      expiresAt: new Date(Date.now() - 1),
    });
    await expect(
      service.open(operator, grantId, { method: 'GET', path: '/x', ip: '' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
