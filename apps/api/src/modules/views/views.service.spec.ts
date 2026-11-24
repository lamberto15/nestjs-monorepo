import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { ListsService } from '../lists/lists.service.js';
import { Records } from '../records/records.service.js';
import { ViewsRepository } from './views.repository.js';
import { ViewsService } from './views.service.js';

/** ViewsService's rules on a stubbed repository: no database. */
describe('ViewsService', () => {
  const repository = { findVisible: vi.fn(), delete: vi.fn(), page: vi.fn() };
  const access = { can: vi.fn() };
  const audit = { record: vi.fn() };
  const organization = { unitsOf: vi.fn() };
  const lists = { mayRead: vi.fn() };
  const records = {
    all: () => [{ declaration: { subject: 'Note' } }],
  };
  const user = { kind: 'user', id: 'user-1' } as RequestPrincipal;
  const view = {
    id: 'v1',
    subject: 'Note',
    name: 'Mine',
    visibility: 'tenant',
    unitId: null,
    owner: 'user:other',
    query: {},
    columns: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let service: ViewsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    organization.unitsOf.mockResolvedValue(['u1']);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ViewsService,
        { provide: ViewsRepository, useValue: repository },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        { provide: OrganizationService, useValue: organization },
        { provide: ListsService, useValue: lists },
        { provide: Records, useValue: records },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(ViewsService);
  });

  it('hides a view of a list the principal may not read: 404', async () => {
    repository.findVisible.mockResolvedValue(view);
    lists.mayRead.mockResolvedValue(false);
    await expect(service.get(user, 'v1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.findVisible).toHaveBeenCalledWith(
      { owner: 'user:user-1', unitIds: ['u1'] },
      'v1',
    );
  });

  it('asks for no rows when no list is readable', async () => {
    lists.mayRead.mockResolvedValue(false);
    repository.page.mockResolvedValue([[], undefined]);
    await service.page(user, { limit: 10 } as never);
    expect(repository.page).toHaveBeenCalledWith(
      { owner: 'user:user-1', unitIds: ['u1'] },
      [],
      { limit: 10 },
    );
  });

  it('lets a non-manager delete only their own view', async () => {
    repository.findVisible.mockResolvedValue(view);
    lists.mayRead.mockResolvedValue(true);
    access.can.mockResolvedValue(false);
    await expect(service.remove(user, 'v1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.delete).not.toHaveBeenCalled();
  });
});
