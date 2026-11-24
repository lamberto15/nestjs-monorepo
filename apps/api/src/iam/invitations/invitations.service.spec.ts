import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { InvitationUnits } from './invitation-units.js';
import { invitationsConfig } from './invitations.config.js';
import { InvitationsRepository } from './invitations.repository.js';
import { InvitationsService } from './invitations.service.js';

/** InvitationsService's rules on a stubbed repository: no database. */
describe('InvitationsService', () => {
  const tenantId = '0195b4a0-0000-7000-8000-000000000001';
  const token = `inv_${tenantId}_${'a'.repeat(43)}`;
  const repository = {
    insert: vi.fn(),
    lockPending: vi.fn(),
    deletePending: vi.fn(),
    deletePendingTo: vi.fn(),
    findByLink: vi.fn(),
    findAccountByEmail: vi.fn(),
  };
  const tenancy = {
    tenantId: () => tenantId,
    find: vi.fn(),
    run: (_: string, work: () => unknown) => work(),
  };
  const audit = { record: vi.fn() };
  const actor = { kind: 'user', id: 'admin' } as UserPrincipal;
  let service: InvitationsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvitationsService,
        { provide: InvitationsRepository, useValue: repository },
        { provide: Tenancy, useValue: tenancy },
        { provide: AuditService, useValue: audit },
        { provide: RolesService, useValue: { checkRoleGrant: vi.fn() } },
        {
          provide: InvitationUnits,
          useValue: { assertExist: vi.fn(), assertAuthority: vi.fn() },
        },
        { provide: invitationsConfig.KEY, useValue: { ttlHours: 72 } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(InvitationsService);
  });

  it('sends nothing without an address', async () => {
    await expect(service.create({ roleIds: [] }, actor)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'email_required' }),
    });
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('prepares one with no link, replacing a pending one to the address', async () => {
    repository.insert.mockImplementation(async (values) => ({
      id: 'i1',
      ...values,
    }));
    const { token: none } = await service.create(
      { email: 'Bo@Example.com', roleIds: ['r1', 'r1'] },
      actor,
      false,
    );
    expect(none).toBeNull();
    expect(repository.deletePendingTo).toHaveBeenCalledWith(
      'bo@example.com',
      undefined,
    );
    expect(repository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ roleIds: ['r1'], email: 'bo@example.com' }),
    );
    expect(repository.insert.mock.calls[0][0]).not.toHaveProperty('tokenHash');
  });

  it('answers 404 for an invitation no longer pending, auditing nothing', async () => {
    repository.deletePending.mockResolvedValue(undefined);
    await expect(service.revoke(actor, 'i9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    repository.lockPending.mockResolvedValue(undefined);
    await expect(service.send(actor, 'i9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a link of another shape, or of an inactive tenant, the same way', async () => {
    await expect(service.accept('nope', {}, null, '')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    tenancy.find.mockResolvedValue({ active: false });
    await expect(service.accept(token, {}, null, '')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'invitation_invalid' }),
    });
  });

  it('wants an existing account signed in as itself', async () => {
    tenancy.find.mockResolvedValue({ active: true });
    repository.findByLink.mockResolvedValue({
      id: 'i1',
      email: 'bo@example.com',
    });
    repository.findAccountByEmail.mockResolvedValue({ id: 'bo', active: true });
    await expect(service.accept(token, {}, null, '')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.accept(token, {}, actor, '')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
