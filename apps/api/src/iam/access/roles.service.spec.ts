import { TransactionHost } from '@nestjs-cls/transactional';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service.js';
import type { UserPrincipal } from '../auth/principal.js';
import { AccessService } from './access.service.js';
import { PermissionCatalog } from './permission-catalog.js';
import { ALL } from './permissions.js';
import { RolesRepository } from './roles.repository.js';
import { RolesService } from './roles.service.js';

/** RolesService's rules on a stubbed repository: no database. */
describe('RolesService', () => {
  const repository = {
    findById: vi.fn(),
    existingIds: vi.fn(),
    lock: vi.fn(),
    lockByKey: vi.fn(),
    countActiveAdministrators: vi.fn(),
    permissionsOf: vi.fn(),
    permissionRowsOf: vi.fn(),
    memberCounts: vi.fn(),
    roleIdsOfUser: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const access = { permissions: vi.fn(), invalidate: vi.fn() };
  const catalog = {
    validate: vi.fn((permission: object) => ({ ok: true, value: permission })),
  };
  const actor = { kind: 'user', id: 'me' } as UserPrincipal;
  const note = { subject: 'Note', action: 'read', conditions: [] };
  let service: RolesService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RolesService,
        { provide: RolesRepository, useValue: repository },
        { provide: AccessService, useValue: access },
        { provide: PermissionCatalog, useValue: catalog },
        { provide: AuditService, useValue: { record: vi.fn() } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(RolesService);
    repository.permissionRowsOf.mockResolvedValue([]);
    repository.memberCounts.mockResolvedValue([]);
    repository.permissionsOf.mockResolvedValue([]);
  });

  it('answers 404 for a role that is not there', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(service.get('r9')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('never edits nor deletes the built-in Administrator role', async () => {
    repository.findById.mockResolvedValue({ id: 'r1', system: true });
    await expect(
      service.update(actor, 'r1', { name: 'X', permissions: [] }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove(actor, 'r1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it('lets nobody grant what they do not hold without conditions', async () => {
    access.permissions.mockResolvedValue([
      { ...note, conditions: [{ key: 'mine' }] },
    ]);
    await expect(service.checkGrant(actor, [note])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.checkGrant(actor, [ALL])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    access.permissions.mockResolvedValue([ALL]);
    await expect(service.checkGrant(actor, [note])).resolves.toEqual([note]);
  });

  it('refuses a role of another tenant or none', async () => {
    repository.existingIds.mockResolvedValue(['r1']);
    await expect(
      service.checkRoleGrant(actor, ['r1', 'r2']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the last active administrator, under the built-in role’s lock', async () => {
    repository.countActiveAdministrators.mockResolvedValue(0);
    await expect(service.assertAnAdministratorRemains()).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.lockByKey).toHaveBeenCalledWith('administrator');
  });

  it('checks If-Match under the role’s lock, changing nothing on a stale one', async () => {
    repository.findById.mockResolvedValue({ id: 'r1', system: false });
    access.permissions.mockResolvedValue([ALL]);
    await expect(
      service.update(
        actor,
        'r1',
        { name: 'X', permissions: [] },
        undefined,
        '"stale"',
      ),
    ).rejects.toMatchObject({ status: 412 });
    expect(repository.lock).toHaveBeenCalledWith('r1');
    expect(repository.update).not.toHaveBeenCalled();
  });
});
