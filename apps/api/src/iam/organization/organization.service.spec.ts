import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../access/access.service.js';
import { MembersService } from '../access/members.service.js';
import { RolesService } from '../access/roles.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { OrganizationRepository } from './organization.repository.js';
import { OrganizationService } from './organization.service.js';
import { TreeCycleError } from './tree.js';

/** OrganizationService's rules on a stubbed repository: no database. */
describe('OrganizationService', () => {
  const repository = {
    findById: vi.fn(),
    countChildren: vi.fn(),
    countOpenMemberships: vi.fn(),
    delete: vi.fn(),
    deleteMembershipsAndPaths: vi.fn(),
    moveInTree: vi.fn(),
    update: vi.fn(),
    isTenantMember: vi.fn(),
    openMembershipOf: vi.fn(),
    insertMembership: vi.fn(),
    unitIdsOf: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const access = { can: vi.fn(), invalidate: vi.fn() };
  const members = { find: vi.fn() };
  const roles = { assertAuthorityOver: vi.fn() };
  const actor = { kind: 'user', id: 'admin' } as UserPrincipal;
  const unit = { id: 'u1', type: 'team', name: 'Sales', parentId: null };
  let service: OrganizationService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrganizationService,
        { provide: OrganizationRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: AccessService, useValue: access },
        { provide: MembersService, useValue: members },
        { provide: RolesService, useValue: roles },
        { provide: Tenancy, useValue: { tenantId: () => 'tenant-1' } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(OrganizationService);
    members.find.mockResolvedValue({ email: 'bo@example.com' });
    access.can.mockResolvedValue(true);
  });

  it('answers 404 for a unit the tenant does not have', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.get('u9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses to delete a unit with a unit under it, and deletes nothing', async () => {
    repository.findById.mockResolvedValue(unit);
    repository.countChildren.mockResolvedValue(1);
    repository.countOpenMemberships.mockResolvedValue(0);
    await expect(service.remove(actor, 'u1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'unit_not_empty' }),
    });
    expect(repository.delete).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers 409 for a move under itself', async () => {
    repository.findById.mockResolvedValue(unit);
    repository.moveInTree.mockRejectedValue(new TreeCycleError('u1', 'u2'));
    await expect(
      service.update(actor, 'u1', { parentId: 'u2' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('never lets an administrator change their own units', async () => {
    await expect(
      service.addMember(actor, 'u1', { userId: 'admin' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('places only a member of the tenant, once', async () => {
    repository.findById.mockResolvedValue(unit);
    repository.isTenantMember.mockResolvedValue(false);
    await expect(
      service.addMember(actor, 'u1', { userId: 'bo' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    repository.isTenantMember.mockResolvedValue(true);
    repository.openMembershipOf.mockResolvedValue({ id: 'm1' });
    await expect(
      service.addMember(actor, 'u1', { userId: 'bo' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.insertMembership).not.toHaveBeenCalled();
  });

  it('places someone only in a unit the actor manages or belongs to', async () => {
    access.can.mockResolvedValue(false);
    repository.unitIdsOf.mockResolvedValue(['u2']);
    await expect(
      service.addMember(actor, 'u1', { userId: 'bo' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'unit_authority_required' }),
    });
  });
});
