import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import { AuthorizationService } from '@nestjs/authorization';
import { Test } from '@nestjs/testing';
import { AuditService } from '../../iam/audit/audit.service.js';
import type { UserPrincipal } from '../../iam/auth/principal.js';
import { Records } from '../records/records.service.js';
import { TagsRegistry } from './tags.registry.js';
import { TagsRepository } from './tags.repository.js';
import { TagsService } from './tags.service.js';

vi.mock('@nestjs-cls/transactional', async (actual) => ({
  ...(await actual<typeof import('@nestjs-cls/transactional')>()),
  // `@Transactional()` without a CLS context: the method itself.
  Transactional: () => () => undefined,
}));

/** TagsService's rules on a stubbed repository: no database. */
describe('TagsService', () => {
  const repository = {
    findById: vi.fn(),
    insert: vi.fn(),
    lockRecord: vi.fn(),
    lockTags: vi.fn(),
    tagIdsOf: vi.fn(),
    unlinkExcept: vi.fn(),
    link: vi.fn(),
    tagsOf: vi.fn(),
    usageOf: vi.fn(),
  };
  const registry = { has: vi.fn(), subjects: () => ['Note'] };
  const records = { of: vi.fn() };
  const audit = { record: vi.fn() };
  const authorization = { authorize: vi.fn() };
  const user = { kind: 'user', id: 'user-1' } as UserPrincipal;
  let service: TagsService;

  beforeEach(async () => {
    vi.resetAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        TagsService,
        { provide: TagsRepository, useValue: repository },
        { provide: TagsRegistry, useValue: registry },
        { provide: Records, useValue: records },
        { provide: AuditService, useValue: audit },
        { provide: AuthorizationService, useValue: authorization },
        {
          provide: TransactionHost,
          useValue: { withTransaction: (work: () => unknown) => work() },
        },
      ],
    }).compile();
    service = moduleRef.get(TagsService);
    repository.tagsOf.mockResolvedValue([]);
  });

  it('refuses a subject that takes no tags: 400', async () => {
    registry.has.mockReturnValue(false);
    await expect(
      service.create(user, { subject: 'Invoice', name: 'Urgent' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('answers 409 tag_taken for a name taken', async () => {
    registry.has.mockReturnValue(true);
    repository.insert.mockRejectedValue(
      Object.assign(new Error('duplicate'), { code: '23505' }),
    );
    await expect(
      service.create(user, { subject: 'Note', name: 'Urgent' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 404 for a tag that is not there', async () => {
    repository.findById.mockResolvedValue(undefined);
    await expect(
      service.update(user, 't9', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('names each id that is no tag of the subject, by its path', async () => {
    records.of.mockReturnValue({});
    repository.lockTags.mockResolvedValue(['t1']);
    await expect(
      service.setTags(user, 'Note', 'n1', ['t1', 't2']),
    ).rejects.toMatchObject({
      response: { errors: [{ path: 'tagIds.1' }] },
    });
  });

  it('links what is added, unlinks what is removed, audited once', async () => {
    records.of.mockReturnValue({});
    repository.lockTags.mockResolvedValue(['t1', 't2']);
    repository.tagIdsOf.mockResolvedValue(['t2', 't3']);
    await service.setTags(user, 'Note', 'n1', ['t1', 't2']);
    expect(repository.unlinkExcept).toHaveBeenCalledWith('Note', 'n1', [
      't1',
      't2',
    ]);
    expect(repository.link).toHaveBeenCalledWith('Note', 'n1', ['t1']);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      user,
      expect.objectContaining({
        action: 'tags.changed',
        details: expect.objectContaining({ added: ['t1'], removed: ['t3'] }),
      }),
    );
  });

  it('asks the record policy before setting a record’s tags', async () => {
    const row = { id: 'n1' };
    const policy = class {};
    records.of.mockReturnValue({
      store: { findOne: async () => row },
      feature: { policy },
    });
    authorization.authorize.mockRejectedValue(new Error('forbidden'));
    await expect(service.setRecordTags(user, 'Note', 'n1', [])).rejects.toThrow(
      'forbidden',
    );
    expect(authorization.authorize).toHaveBeenCalledWith(
      policy,
      'update',
      user,
      row,
    );
    expect(repository.lockRecord).not.toHaveBeenCalled();
  });
});
