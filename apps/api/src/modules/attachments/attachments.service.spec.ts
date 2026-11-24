import { ConflictException, NotFoundException } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { StorageDisk } from '@nestjs/storage';
import { Test } from '@nestjs/testing';
import { AccessService } from '../../iam/access/access.service.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { LegalHoldsService } from '../../iam/holds/holds.service.js';
import { Records } from '../records/records.service.js';
import { StoredFiles } from '../storage/storage.release.js';
import { attachmentsConfig } from './attachments.config.js';
import { AttachmentsRepository } from './attachments.repository.js';
import { AttachmentsService } from './attachments.service.js';

/** AttachmentsService's rules on a stubbed repository: no database. */
describe('AttachmentsService', () => {
  const repository = {
    find: vi.fn(),
    versionKeys: vi.fn(),
    deleteUnlocked: vi.fn(),
    versionKeysOfRecords: vi.fn(),
    deleteOfRecords: vi.fn(),
  };
  const files = { release: vi.fn() };
  const disk = { delete: vi.fn() };
  const audit = { record: vi.fn() };
  const holds = { assertNotHeld: vi.fn() };
  const user = { kind: 'user', id: 'u1', tenantId: 't1' } as UserPrincipal;
  const file = {
    id: 'a1',
    subject: 'Note',
    recordId: 'r1',
    key: 'tenants/t1/attachments/a1.pdf',
    name: 'a.pdf',
    size: 1,
    contentType: 'application/pdf',
    uploadedBy: 'user:u1',
    locked: false,
    fields: null,
    renditions: {},
  };
  let service: AttachmentsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    disk.delete.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AttachmentsService,
        { provide: AttachmentsRepository, useValue: repository },
        { provide: StoredFiles, useValue: files },
        { provide: StorageDisk, useValue: disk },
        { provide: AuditService, useValue: audit },
        { provide: LegalHoldsService, useValue: holds },
        { provide: AccessService, useValue: { redact: vi.fn() } },
        {
          provide: Records,
          useValue: {
            find: () => ({ store: { findOne: async () => ({ id: 'r1' }) } }),
          },
        },
        { provide: attachmentsConfig.KEY, useValue: {} },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(AttachmentsService);
  });

  it('answers 404 for an attachment that is not there', async () => {
    await expect(service.findReadable(user, 'a1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('never removes an issued document', async () => {
    repository.find.mockResolvedValue({ ...file, locked: true });
    await expect(service.remove(user, 'a1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(repository.deleteUnlocked).not.toHaveBeenCalled();
  });

  it('removes its uploader’s file with its versions, audited', async () => {
    repository.find.mockResolvedValue(file);
    repository.versionKeys.mockResolvedValue(['v1']);
    repository.deleteUnlocked.mockResolvedValue(file);
    await service.remove(user, 'a1');
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({ action: 'attachment.removed' }),
    );
    expect(disk.delete).toHaveBeenCalledWith([file.key, 'v1']);
  });

  it('releases the files of records gone for good', async () => {
    repository.versionKeysOfRecords.mockResolvedValue(['v1']);
    repository.deleteOfRecords.mockResolvedValue([file]);
    await service.forget('Note', ['r1']);
    expect(files.release).toHaveBeenCalledWith([file.key, 'v1']);
  });
});
