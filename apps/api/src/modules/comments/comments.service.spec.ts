import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { Test } from '@nestjs/testing';
import { inTenantOf } from '../../core/tenancy/tenant-job.js';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { RECORD } from '../records/record-extension.js';
import { Records } from '../records/records.service.js';
import { CommentsRepository } from './comments.repository.js';
import { CommentsService, MAX_REPLIES } from './comments.service.js';

/** CommentsService's rules on a stubbed repository: no database. */
describe('CommentsService', () => {
  const repository = {
    findOne: vi.fn(),
    countReplies: vi.fn(),
    hasCommented: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const audit = { record: vi.fn() };
  const store = { findOne: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  const comment = (fields: object = {}) => ({
    id: 'c1',
    subject: 'Note',
    recordId: 'r1',
    author: 'user:user-1',
    body: 'Hello',
    mentions: [],
    parentId: null,
    resolvedAt: null,
    resolvedBy: null,
    editedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  });
  let service: CommentsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    store.findOne.mockResolvedValue({ id: 'r1' });
    const moduleRef = await Test.createTestingModule({
      providers: [
        CommentsService,
        { provide: RECORD, useValue: { subject: 'Note', noun: 'note' } },
        { provide: CommentsRepository, useValue: repository },
        { provide: AuditService, useValue: audit },
        { provide: Records, useValue: { of: () => ({ store }) } },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    })
      // Access, users, people, notifications and realtime: unused by these rules.
      .useMocker(() => ({}))
      .compile();
    service = moduleRef.get(CommentsService);
  });

  it('answers 404 for a comment of another record', async () => {
    repository.findOne.mockResolvedValue(undefined);
    await expect(
      service.edit(user, 'r1', 'c9', 'Changed'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.findOne).toHaveBeenCalledWith('Note', 'r1', 'c9');
  });

  it("refuses to change someone else's comment", async () => {
    repository.findOne.mockResolvedValue(comment({ author: 'user:other' }));
    await expect(
      service.edit(user, 'r1', 'c1', 'Changed'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('answers a top-level comment only', async () => {
    repository.findOne.mockResolvedValue(comment({ parentId: 'c0' }));
    await expect(
      inTenantOf({ tenantId: '00000000-0000-4000-8000-00000000000a' }, () =>
        service.add(user, 'r1', 'A reply', 'c1'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`takes at most ${MAX_REPLIES} replies in a thread`, async () => {
    repository.findOne.mockResolvedValue(comment());
    repository.countReplies.mockResolvedValue(MAX_REPLIES);
    await expect(
      inTenantOf({ tenantId: '00000000-0000-4000-8000-00000000000a' }, () =>
        service.add(user, 'r1', 'A reply', 'c1'),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('resolves only a thread', async () => {
    repository.findOne.mockResolvedValue(comment({ parentId: 'c0' }));
    await expect(service.resolve(user, 'r1', 'c1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
