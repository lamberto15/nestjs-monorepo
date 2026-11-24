import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AuthenticationStorage,
  type SessionRecord,
  SessionService,
} from '@nestjs/authentication';
import { Test } from '@nestjs/testing';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../auth/users.repository.js';
import { impersonationConfig } from './impersonation.config.js';
import { ImpersonationPolicy } from './impersonation.policy.js';
import { ImpersonationRepository } from './impersonation.repository.js';
import { ImpersonationService } from './impersonation.service.js';

/** ImpersonationService's rules on a stubbed repository: no database. */
describe('ImpersonationService', () => {
  const repository = { holdsSystemRole: vi.fn() };
  const users = { inTenant: vi.fn() };
  const policy = { impersonate: vi.fn() };
  const roles = { assertAuthorityOver: vi.fn() };
  const audit = { record: vi.fn() };
  const admin = { kind: 'user', id: 'admin', tenantId: 't1' } as UserPrincipal;
  const target = {
    kind: 'user',
    id: 'bo',
    tenantId: 't1',
    email: 'bo@example.com',
  } as UserPrincipal;
  const session = { id: 's1', metadata: {} } as SessionRecord;
  let service: ImpersonationService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ImpersonationService,
        { provide: ImpersonationRepository, useValue: repository },
        { provide: UsersRepository, useValue: users },
        { provide: ImpersonationPolicy, useValue: policy },
        { provide: RolesService, useValue: roles },
        { provide: AuditService, useValue: audit },
        { provide: SessionService, useValue: {} },
        { provide: AuthenticationStorage, useValue: {} },
        { provide: impersonationConfig.KEY, useValue: { ttlMinutes: 30 } },
      ],
    }).compile();
    service = moduleRef.get(ImpersonationService);
  });

  it('never impersonates oneself', async () => {
    await expect(service.start(admin, session, 'admin')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('answers 404 for a user of another tenant', async () => {
    users.inTenant.mockResolvedValue({ ...target, tenantId: 't2' });
    await expect(service.start(admin, session, 'bo')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never acts as an administrator', async () => {
    policy.impersonate.mockResolvedValue(true);
    repository.holdsSystemRole.mockResolvedValue(true);
    await expect(service.assertEligible(admin, target)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.mayImpersonate(admin, target)).resolves.toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
