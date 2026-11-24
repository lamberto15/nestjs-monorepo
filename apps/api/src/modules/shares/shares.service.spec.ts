import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { Tenancy } from '../../core/tenancy/tenancy.service.js';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type {
  RequestPrincipal,
  UserPrincipal,
} from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { SharesRepository } from './shares.repository.js';
import { SharesService } from './shares.service.js';

/** SharesService's rules on a stubbed repository: no database. */
describe('SharesService', () => {
  const repository = {
    findOfRecord: vi.fn(),
    revoke: vi.fn(),
    findWorking: vi.fn(),
  };
  const access = { can: vi.fn() };
  const audit = { record: vi.fn() };
  const tenancy = { find: vi.fn(), run: vi.fn() };
  const row = { id: 'n1' };
  const records = {
    of: () => ({ store: { findOne: async () => row } }),
  };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const record = { subject: 'Note', recordId: 'n1' };
  let service: SharesService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SharesService,
        { provide: SharesRepository, useValue: repository },
        { provide: AccessService, useValue: access },
        { provide: AuditService, useValue: audit },
        { provide: Tenancy, useValue: tenancy },
        { provide: Records, useValue: records },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Mail, files, users, config and Redis: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(SharesService);
  });

  it('lets only a person make a link', async () => {
    const client = { kind: 'client', id: 'c1' } as RequestPrincipal;
    await expect(
      service.create(client, record, {} as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 for a link the record does not have', async () => {
    repository.findOfRecord.mockResolvedValue(undefined);
    await expect(service.revoke(user, record, 's9')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lets its maker revoke a link without the share permission, audited', async () => {
    repository.findOfRecord.mockResolvedValue({
      id: 's1',
      createdBy: 'user:user-1',
      revokedAt: null,
      subject: 'Note',
      recordId: 'n1',
    });
    await service.revoke(user, record, 's1');
    expect(access.can).not.toHaveBeenCalled();
    expect(repository.revoke).toHaveBeenCalledWith('s1', 'user:user-1');
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'share.revoked', targetId: 's1' }),
    );
  });

  it('asks someone else for the share permission, and changes nothing twice', async () => {
    repository.findOfRecord.mockResolvedValue({
      id: 's1',
      createdBy: 'user:other',
      revokedAt: new Date(),
    });
    access.can.mockResolvedValue(true);
    await service.revoke(user, record, 's1');
    expect(access.can).toHaveBeenCalledWith(user, 'share', 'Note', row);
    expect(repository.revoke).not.toHaveBeenCalled();
  });

  it('refuses a forged token with the one 404, asking nothing', async () => {
    await expect(service.open({ token: 'shr_nope' })).rejects.toMatchObject({
      response: { code: 'share_not_found' },
    });
    expect(tenancy.find).not.toHaveBeenCalled();
  });
});
