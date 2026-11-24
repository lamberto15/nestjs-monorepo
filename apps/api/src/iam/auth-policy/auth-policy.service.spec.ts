import { TransactionHost } from '@nestjs-cls/transactional';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { MfaService } from '@nestjs/authentication';
import { Test } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { accountConfig } from '../account/account.config.js';
import { AuditService } from '../audit/audit.service.js';
import { authConfig } from '../auth/auth.config.js';
import type { UserPrincipal } from '../auth/principal.js';
import { OrganizationService } from '../organization/organization.service.js';
import { AuthPolicyRepository } from './auth-policy.repository.js';
import { TenantAuthPolicies } from './auth-policy.service.js';

/** TenantAuthPolicies' rules on a stubbed repository: no database. */
describe('TenantAuthPolicies', () => {
  const repository = {
    findTenantPolicy: vi.fn(),
    saveTenantPolicy: vi.fn(),
    findPlatformPolicy: vi.fn(),
    anyUnitRequiresMfa: vi.fn(),
  };
  const mfa = { isEnrolled: vi.fn() };
  const organization = { unitsOf: vi.fn(), ancestry: vi.fn() };
  const audit = { record: vi.fn() };
  const user = { kind: 'user', id: 'u1', tenantId: 't1' } as UserPrincipal;
  let policies: TenantAuthPolicies;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TenantAuthPolicies,
        { provide: AuthPolicyRepository, useValue: repository },
        { provide: MfaService, useValue: mfa },
        { provide: OrganizationService, useValue: organization },
        { provide: AuditService, useValue: audit },
        {
          provide: ClsService,
          useValue: { isActive: () => false, get: () => undefined },
        },
        {
          provide: Tenancy,
          useValue: { run: (_: string, work: () => unknown) => work() },
        },
        {
          provide: authConfig.KEY,
          useValue: { sessionIdleMinutes: 60, sessionMaxHours: 12 },
        },
        { provide: accountConfig.KEY, useValue: { mfa: true } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    policies = moduleRef.get(TenantAuthPolicies);
  });

  it('reads a tenant without a policy as the defaults', async () => {
    repository.findTenantPolicy.mockResolvedValue(undefined);
    await expect(policies.get('t1')).resolves.toMatchObject({
      requireMfa: false,
      allowBreakGlass: true,
    });
  });

  it("refuses a session limit over the deployment's, saving nothing", async () => {
    await expect(
      policies.update(user, 't1', { sessionIdleMinutes: 90 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.saveTenantPolicy).not.toHaveBeenCalled();
  });

  it('refuses to require two-factor of a writer who has none', async () => {
    mfa.isEnrolled.mockResolvedValue(false);
    await expect(
      policies.update(user, 't1', { requireMfa: true }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('saves the change over what was stored, audited', async () => {
    repository.findTenantPolicy.mockResolvedValue(undefined);
    await policies.update(user, 't1', { passwordMinLength: 14 });
    expect(repository.saveTenantPolicy).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ passwordMinLength: 14, requireMfa: false }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'auth-policy.updated' }),
    );
  });

  it('requires two-factor of a member of a unit under one that requires it', async () => {
    repository.findPlatformPolicy.mockResolvedValue(undefined);
    repository.findTenantPolicy.mockResolvedValue(undefined);
    organization.unitsOf.mockResolvedValue(['team']);
    organization.ancestry.mockResolvedValue([['team'], ['division']]);
    repository.anyUnitRequiresMfa.mockResolvedValue(true);
    await expect(policies.requireMfa(user)).resolves.toBe(true);
    expect(repository.anyUnitRequiresMfa).toHaveBeenCalledWith([
      'team',
      'division',
    ]);
  });
});
