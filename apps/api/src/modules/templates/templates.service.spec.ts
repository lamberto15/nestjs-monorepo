import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { RequestPrincipal } from '../../iam/auth/principal.js';
import { OrganizationService } from '../../iam/organization/organization.service.js';
import { Records } from '../records/records.service.js';
import { TemplatesRepository } from './templates.repository.js';
import { TemplatesService } from './templates.service.js';

/** TemplatesService's rules on a stubbed repository: no database. */
describe('TemplatesService', () => {
  const repository = {
    findVisible: vi.fn(),
    findUnitId: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const access = { can: vi.fn() };
  const audit = { record: vi.fn() };
  const organization = { unitsOf: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as RequestPrincipal;
  const template = {
    id: 't1',
    subject: 'Note',
    name: 'Weekly',
    visibility: 'unit',
    unitId: 'u1',
    owner: 'user:other',
    values: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let service: TemplatesService;

  beforeEach(async () => {
    vi.resetAllMocks();
    organization.unitsOf.mockResolvedValue(['u1']);
    const moduleRef = await Test.createTestingModule({
      providers: [
        TemplatesService,
        { provide: TemplatesRepository, useValue: repository },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        { provide: OrganizationService, useValue: organization },
        { provide: Records, useValue: { all: () => [] } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(TemplatesService);
  });

  it('looks for a template among those the principal sees: theirs, their units’', async () => {
    repository.findVisible.mockResolvedValue(undefined);
    await expect(service.get(user, 't9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repository.findVisible).toHaveBeenCalledWith(
      { owner: 'user:user-1', unitIds: ['u1'] },
      't9',
    );
  });

  it('lets only its owner, or a manager of a shared one, delete it', async () => {
    repository.findVisible.mockResolvedValue(template);
    access.can.mockResolvedValue(false);
    await expect(service.remove(user, 't1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(repository.delete).not.toHaveBeenCalled();

    repository.findVisible.mockResolvedValue({
      ...template,
      owner: 'user:user-1',
    });
    await service.remove(user, 't1');
    expect(repository.delete).toHaveBeenCalledWith('t1');
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'recordTemplate.deleted' }),
    );
  });

  it('names its unit for a unit template: 400', async () => {
    repository.findVisible.mockResolvedValue({
      ...template,
      owner: 'user:user-1',
      visibility: 'private',
      unitId: null,
    });
    await expect(
      service.update(user, 't1', { visibility: 'unit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('shares with a unit only one that exists', async () => {
    repository.findVisible.mockResolvedValue({
      ...template,
      owner: 'user:user-1',
      visibility: 'private',
      unitId: null,
    });
    repository.findUnitId.mockResolvedValue(undefined);
    await expect(
      service.update(user, 't1', { visibility: 'unit', unitId: 'u2' }),
    ).rejects.toMatchObject({
      response: { errors: [{ path: 'unitId', message: 'No such unit.' }] },
    });
    expect(repository.update).not.toHaveBeenCalled();
  });
});
